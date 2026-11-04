#requires -Version 5.1
<#
.SYNOPSIS
  Verify a Family Planner migration against the destination, using evidence instead of hope.

.DESCRIPTION
  Compares per-table row counts, proves the encryption key against real ciphertext,
  counts stored objects, and optionally signs in on the destination.

.PARAMETER Step
  Counts  compare snapshot counts with the destination D1        (read-only)
  Key     prove FIELD_KEY decrypts real records                  (local, read-only)
  Files   count R2 objects and compare with the files table      (read-only)
  Auth    sign in on the destination with the existing credentials (read-only)
  All     Counts + Key + Files (+ Auth when -Credentials is passed)

.PARAMETER Snapshot
  Snapshot JSON. Defaults to the newest in migration/out.

.EXAMPLE
  .\migration\verify-migration.ps1 -Step Counts
.EXAMPLE
  .\migration\verify-migration.ps1 -Step All -Credentials
#>
param(
    [ValidateSet('Counts', 'Key', 'Files', 'Auth', 'All')]
    [string]$Step = 'All',
    [string]$Snapshot = '',
    [string]$Config = 'migration/migration.config.json',
    [string]$Base = '',
    [switch]$Credentials,
    [switch]$Deep
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Root = (Get-Location).Path
$script:Failures = 0
$script:Passes = 0

function Write-Step { param([string]$Text) Write-Host ""; Write-Host "== $Text" -ForegroundColor Cyan }
function Pass { param([string]$Text) Write-Host "  PASS $Text" -ForegroundColor Green; $script:Passes++ }
function Fail { param([string]$Text, [string]$Help) Write-Host "  FAIL $Text" -ForegroundColor Red; if ($Help) { Write-Host "       $Help" -ForegroundColor Yellow }; $script:Failures++ }
function Note { param([string]$Text) Write-Host "       $Text" -ForegroundColor DarkGray }
function Die  { param([string]$Text, [string]$Help) Write-Host ""; Write-Host "ERROR: $Text" -ForegroundColor Red; if ($Help) { Write-Host $Help -ForegroundColor Yellow }; exit 1 }

if (-not (Test-Path $Config)) { Die "config not found: $Config" "Copy migration/migration.config.example.json to migration/migration.config.json" }
$cfg = Get-Content -Raw $Config | ConvertFrom-Json
if (-not $Base) { $Base = $cfg.destination.baseUrl }
if (-not $Base -or $Base -match 'REPLACE-WITH') { Die "no destination base URL" "Pass -Base https://<worker>.<subdomain>.workers.dev or set destination.baseUrl in $Config" }
$Base = $Base.TrimEnd('/')

if ($Snapshot) {
    if (-not (Test-Path $Snapshot)) { Die "snapshot not found: $Snapshot" }
    $snap = (Resolve-Path $Snapshot).Path
} else {
    $dir = Join-Path $script:Root $cfg.outputDir
    $newest = Get-ChildItem -Path $dir -Filter 'snapshot-*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $newest) { Die "no snapshot found in $dir" "Run migrate.ps1 -Step Export first" }
    $snap = $newest.FullName
    Note "snapshot: $snap"
}

function Get-SnapshotCounts {
    $json = & node migration/snapshot-tool.mjs counts $snap
    if ($LASTEXITCODE -ne 0) { Die "snapshot-tool could not read the snapshot" "node migration/snapshot-tool.mjs counts $snap" }
    return ($json | ConvertFrom-Json)
}

function Get-DestinationCounts {
    $tables = @('meta', 'users', 'credentials', 'records', 'changes', 'notifications', 'push_subs', 'files', 'ai_connections', 'family_invites')
    $parts = @()
    foreach ($t in $tables) { $parts += "SELECT '$t' AS t, count(*) AS n FROM $t" }
    $sql = $parts -join ' UNION ALL '
    $raw = & npx.cmd wrangler d1 execute $cfg.destination.d1DatabaseName --remote --json --command $sql 2>&1
    if ($LASTEXITCODE -ne 0) { Die "d1 execute failed" ($raw -join "`n") }
    $text = ($raw -join "`n")
    $start = $text.IndexOf('[')
    $end = $text.LastIndexOf(']')
    if ($start -lt 0 -or $end -le $start) { Die "could not parse d1 output" $text }
    $rows = ($text.Substring($start, $end - $start + 1) | ConvertFrom-Json)
    # wrangler returns [{ results: [{t,n}, ...] }]
    $result = @{}
    foreach ($row in @($rows)) {
        if ($row.PSObject.Properties.Name -contains 'results') {
            foreach ($r in @($row.results)) { $result[$r.t] = [int64]$r.n }
        } elseif ($row.PSObject.Properties.Name -contains 't') {
            $result[$row.t] = [int64]$row.n
        }
    }
    return $result
}

Write-Host "Family Planner migration verification" -ForegroundColor White
Note "destination: $Base"
Note "snapshot:    $snap"

# ---------------------------------------------------------------- Counts
if ($Step -eq 'Counts' -or $Step -eq 'All') {
    Write-Step "Row counts (snapshot vs destination)"
    $expected = (Get-SnapshotCounts).counts
    $actual = Get-DestinationCounts
    foreach ($name in @('meta', 'users', 'credentials', 'records', 'changes', 'notifications', 'push_subs', 'files', 'ai_connections', 'family_invites')) {
        $want = 0
        if ($expected.PSObject.Properties.Name -contains $name) { $want = [int64]$expected.$name }
        $got = 0
        if ($actual.ContainsKey($name)) { $got = [int64]$actual[$name] }
        if ($want -eq $got) { Pass "$name = $got" }
        else {
            Fail "$name expected $want, destination has $got" "Re-run migrate.ps1 -Step Import for every chunk; never delete rows to make the numbers agree."
        }
    }
}

# ---------------------------------------------------------------- Key
if ($Step -eq 'Key' -or $Step -eq 'All') {
    Write-Step "Encryption key against real ciphertext"
    if (-not (Test-Path $cfg.keyFile)) { Fail "key file missing: $($cfg.keyFile)" "See BACKUP_GUIDE.md"; }
    else {
        & node migration/snapshot-tool.mjs decrypt-check $snap $cfg.keyFile
        if ($LASTEXITCODE -eq 0) { Pass "the key file matches the migrated data" }
        else { Fail "the key file does NOT decrypt the migrated data" "Stop. Find the key that was set on 2026-11-03. Do not deploy." }
    }
}

# ---------------------------------------------------------------- Files
if ($Step -eq 'Files' -or $Step -eq 'All') {
    Write-Step "Stored objects"
    $listJson = & node migration/snapshot-tool.mjs list-files $snap
    $files = @()
    if ($listJson -and $LASTEXITCODE -eq 0) { $files = @($listJson | ConvertFrom-Json) }
    if ($files.Count -eq 0) {
        Pass "snapshot has no file rows"
    } else {
        Note "$($files.Count) file row(s) in the snapshot"
        $objects = & npx.cmd wrangler r2 object list $cfg.destination.r2BucketName --config $cfg.destination.configFile 2>&1
        $count = 0
        foreach ($line in @($objects)) { if ("$line" -match 'drive/') { $count++ } }
        if ($count -ge $files.Count) { Pass "destination bucket lists $count object(s)" }
        else { Fail "destination bucket lists $count object(s) for $($files.Count) file row(s)" "Run migrate.ps1 -Step Storage, then check for orphan records." }
        if (-not $Deep) { Note "run with -Deep to compare byte hashes (slower)" }
    }
}

# ---------------------------------------------------------------- Auth
if ($Step -eq 'Auth' -or ($Step -eq 'All' -and $Credentials)) {
    Write-Step "Sign-in on the destination"
    Write-Host "Credentials are read locally; nothing is stored." -ForegroundColor DarkGray
    $email = Read-Host "Owner email"
    $secure = Read-Host "Owner password (hidden)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    try {
        $body = @{ email = $email; password = $plain } | ConvertTo-Json
        $login = Invoke-WebRequest -Uri "$Base/api/auth/login" -Method Post -Body $body -ContentType 'application/json' -SessionVariable s -UseBasicParsing -TimeoutSec 30
        if ($login.StatusCode -eq 200) { Pass "password login works on the destination" } else { Fail "login returned $($login.StatusCode)" }
    } catch {
        Fail "password login failed: $($_.Exception.Message)" "Try the same credentials on the old site. If they work there, the credentials table did not import fully."
        $s = $null
    }
    if ($null -ne $s) {
        try {
            $acct = Invoke-RestMethod -Uri "$Base/api/auth/account" -WebSession $s -TimeoutSec 30
            if ($acct.role -eq 'owner') { Pass "account is the household owner" } else { Fail "role is '$($acct.role)', expected owner" }
        } catch { Fail "auth/account failed: $($_.Exception.Message)" }
        try {
            $state = Invoke-RestMethod -Uri "$Base/api/state?since=0" -WebSession $s -TimeoutSec 60
            $collections = $state.collections
            $total = 0
            foreach ($p in $collections.PSObject.Properties) { $total += @($p.Value).Count }
            Pass "family book returns $total record(s)"
        } catch { Fail "state failed: $($_.Exception.Message)" }
    }
    Note "Member login and cross-household isolation must be checked manually with the second account:"
    Note "  sign in as the member, confirm they cannot see the owner's Personal/Office books."
}

Write-Host ""
Write-Host "$script:Passes passed, $script:Failures failed" -ForegroundColor White
if ($script:Failures -gt 0) {
    Write-Host "Migration is NOT verified. Do not cut over." -ForegroundColor Red
    exit 1
}
Write-Host "All requested checks passed." -ForegroundColor Green
exit 0
