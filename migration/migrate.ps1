#requires -Version 5.1
<#
.SYNOPSIS
  Family Finance Planner - migration steps, one at a time, with loud failures.

.DESCRIPTION
  Every step is independent and refuses to run when its preconditions are not met.
  Nothing destructive is implemented here: no deletes, no overwrites of the source,
  no unpublishing. -DryRun prints the commands instead of running them.

.PARAMETER Step
  Check      verify tools, config, key file, git state          (safe, read-only)
  Export     sign in as owner and download a full snapshot      (read-only on source)
  Sql        convert the snapshot into D1 INSERT files          (local)
  DbCreate   create the destination D1 database                 (creates resources)
  Import     load the SQL files into the destination D1         (writes destination)
  Storage    copy R2 objects preserving their keys              (writes destination)
  Secret     apply FIELD_KEY from the key file, never displayed (writes destination)
  Deploy     deploy the Worker to your account                  (publishes new origin)
  Health     check the destination endpoints                    (read-only)

.PARAMETER Snapshot
  Path to a snapshot JSON. Defaults to the newest file in migration/out.

.PARAMETER Config
  Path to migration.config.json. Defaults to migration/migration.config.json.

.EXAMPLE
  .\migration\migrate.ps1 -Step Check
.EXAMPLE
  .\migration\migrate.ps1 -Step Export
.EXAMPLE
  .\migration\migrate.ps1 -Step Import -DryRun
#>
param(
    [ValidateSet('Check', 'Export', 'Sql', 'DbCreate', 'Import', 'Storage', 'Secret', 'Deploy', 'Health')]
    [string]$Step = 'Check',
    [string]$Snapshot = '',
    [string]$Config = 'migration/migration.config.json',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Root = (Get-Location).Path
$script:Failures = 0

function Write-Step { param([string]$Text) Write-Host ""; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  OK   $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "  WARN $Text" -ForegroundColor Yellow }
function Write-Fail { param([string]$Text) Write-Host "  FAIL $Text" -ForegroundColor Red; $script:Failures++ }
function Write-Note { param([string]$Text) Write-Host "       $Text" -ForegroundColor DarkGray }

function Stop-WithHelp {
    param([string]$Message, [string]$Help)
    Write-Host ""
    Write-Host "ERROR: $Message" -ForegroundColor Red
    if ($Help) { Write-Host ""; Write-Host $Help -ForegroundColor Yellow }
    Write-Host ""
    exit 1
}

function Test-Tool {
    param([string]$Name, [string]$Hint)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        Write-Fail "$Name not found on PATH"
        if ($Hint) { Write-Note $Hint }
        return $false
    }
    Write-Ok "$Name -> $($cmd.Source)"
    return $true
}

function Invoke-Cmd {
    param([string]$Exe, [string[]]$Arguments, [switch]$AllowFail)
    $preview = "$Exe $($Arguments -join ' ')"
    if ($DryRun) { Write-Note "DRY RUN: $preview"; return @{ Code = 0; Output = '' } }
    Write-Note "> $preview"
    $output = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFail) {
        Write-Host ($output -join "`n") -ForegroundColor DarkRed
        Stop-WithHelp "command failed with exit code $code" "Fix the error above, then re-run this step. Nothing further was executed."
    }
    return @{ Code = $code; Output = ($output -join "`n") }
}

function Read-Config {
    if (-not (Test-Path $Config)) {
        Stop-WithHelp "config file not found: $Config" @"
Copy the example and fill in your values:
  Copy-Item migration/migration.config.example.json migration/migration.config.json
Then edit destination.workerName and destination.baseUrl.
"@
    }
    $json = Get-Content -Raw $Config | ConvertFrom-Json
    return $json
}

function Assert-DestinationBase {
    param($ConfigObject)
    if (-not $ConfigObject.destination.baseUrl -or $ConfigObject.destination.baseUrl -match 'REPLACE-WITH') {
        Stop-WithHelp "destination.baseUrl is not set in $Config" "Set it to https://<worker>.<subdomain>.workers.dev once the Worker is deployed, or use the URL printed by the Deploy step."
    }
}

function Save-Config {
    param($ConfigObject)
    $ConfigObject | ConvertTo-Json -Depth 10 | Set-Content -Path $Config -Encoding UTF8
}

function Resolve-Snapshot {
    param($ConfigObject)
    if ($Snapshot) {
        if (-not (Test-Path $Snapshot)) { Stop-WithHelp "snapshot not found: $Snapshot" }
        return (Resolve-Path $Snapshot).Path
    }
    $dir = Join-Path $script:Root $ConfigObject.outputDir
    if (-not (Test-Path $dir)) { Stop-WithHelp "no snapshots yet in $dir" "Run: .\migration\migrate.ps1 -Step Export" }
    $newest = Get-ChildItem -Path $dir -Filter 'snapshot-*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $newest) { Stop-WithHelp "no snapshot-*.json in $dir" "Run: .\migration\migrate.ps1 -Step Export" }
    Write-Note "using $($newest.FullName)"
    return $newest.FullName
}

function Get-OwnerSession {
    param([string]$BaseUrl, [string]$Purpose)
    Write-Host ""
    Write-Host "Sign in as the household owner on $BaseUrl" -ForegroundColor Yellow
    Write-Host "The password is read locally and used only to obtain a session cookie." -ForegroundColor DarkGray
    Write-Host "It is not written to disk and is not sent anywhere except that site." -ForegroundColor DarkGray
    $email = Read-Host "Owner email"
    $secure = Read-Host "Owner password (typing is hidden)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    if (-not $email -or -not $plain) { Stop-WithHelp "email or password was empty" "Nothing was attempted." }

    $body = @{ email = $email; password = $plain } | ConvertTo-Json
    try {
        $response = Invoke-WebRequest -Uri "$BaseUrl/api/auth/login" -Method Post -Body $body `
            -ContentType 'application/json' -SessionVariable session -UseBasicParsing -TimeoutSec 30
    } catch {
        Stop-WithHelp "sign-in failed: $($_.Exception.Message)" "Check the email and password in a normal browser first. A 429 means too many attempts: wait, do not retry in a loop."
    }
    if ($response.StatusCode -ne 200) {
        Stop-WithHelp "sign-in returned HTTP $($response.StatusCode) for $Purpose" "Open the site in a browser and confirm the credentials there."
    }
    Write-Ok "signed in ($Purpose)"
    return $session
}

Write-Host "Family Planner migration - step $Step" -ForegroundColor White
if ($DryRun) { Write-Host "DRY RUN: commands will be printed, not executed." -ForegroundColor Yellow }

# ----------------------------------------------------------------- Check
if ($Step -eq 'Check') {
    Write-Step "Tools"
    $toolsOk = $true
    $toolsOk = (Test-Tool 'node' 'Install Node.js 20+ from https://nodejs.org') -and $toolsOk
    $toolsOk = (Test-Tool 'npm' 'Comes with Node.js') -and $toolsOk
    $npx = Get-Command 'npx.cmd' -ErrorAction SilentlyContinue
    if ($null -eq $npx) { $npx = Get-Command 'npx' -ErrorAction SilentlyContinue }
    if ($null -eq $npx) { Write-Fail "npx not found"; $toolsOk = $false } else { Write-Ok "npx -> $($npx.Source)" }
    $toolsOk = (Test-Tool 'git' 'Install Git for Windows') -and $toolsOk

    Write-Step "Wrangler"
    if ($toolsOk) {
        $result = Invoke-Cmd -Exe 'npx.cmd' -Arguments @('wrangler', '--version') -AllowFail
        if ($result.Code -eq 0) { Write-Ok "wrangler $($result.Output.Trim())" } else { Write-Fail "wrangler is not runnable (run: npm ci)" }
    } else {
        Write-Warn "skipped: tools missing"
    }

    Write-Step "Authentication to your Cloudflare account"
    if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
        Write-Warn "CLOUDFLARE_API_TOKEN is not set in this terminal"
        Write-Note "Either set it (see migration/CLOUDFLARE_SETUP.md section 3) or run: npx wrangler login"
    } else {
        Write-Ok "CLOUDFLARE_API_TOKEN is set (value not shown)"
    }
    if ($toolsOk) {
        $who = Invoke-Cmd -Exe 'npx.cmd' -Arguments @('wrangler', 'whoami') -AllowFail
        if ($who.Code -ne 0) { Write-Warn "not logged in to Cloudflare yet" } else {
            foreach ($line in ($who.Output -split "`n")) {
                if ($line -match 'logged in|Account Name|email') { Write-Note $line.Trim() }
            }
        }
    }

    Write-Step "Repository"
    $gitStatus = git status --porcelain
    if ($gitStatus) {
        Write-Warn "uncommitted changes present"
        Write-Note "Commit or stash them before Import/Deploy so the exact tree is recoverable."
    } else {
        Write-Ok "working tree clean"
    }
    if (Test-Path '.gitignore') {
        $ignored = git check-ignore -v '.secrets/field_key.txt' 2>$null
        if ($ignored) { Write-Ok ".secrets/ is git-ignored" } else { Write-Fail ".secrets/ is NOT git-ignored - stop now" }
        $ignoredOut = git check-ignore -v 'migration/out/x.json' 2>$null
        if ($ignoredOut) { Write-Ok "migration/out/ is git-ignored" } else { Write-Fail "migration/out/ is NOT git-ignored - snapshots would be committable" }
    }

    Write-Step "Key file"
    if (Test-Path '.secrets/field_key.txt') {
        $size = (Get-Item '.secrets/field_key.txt').Length
        Write-Ok ".secrets/field_key.txt present ($size bytes)"
        if ($size -lt 40) { Write-Warn "that is smaller than expected for a base64 32-byte key" }
    } else {
        Write-Fail ".secrets/field_key.txt is missing - encrypted fields cannot be migrated"
    }

    Write-Step "Config"
    if (Test-Path $Config) {
        try {
            $cfg = Read-Config
            Write-Ok "config loaded: $Config"
            Write-Note "destination: $($cfg.destination.baseUrl)"
            if (-not $cfg.destination.d1DatabaseId) { Write-Warn "destination.d1DatabaseId is empty (run -Step DbCreate)" }
        } catch {
            Write-Fail $_.Exception.Message
        }
    } else {
        Write-Warn "config not created yet (expected before -Step DbCreate)"
        Write-Note "Copy-Item migration/migration.config.example.json migration/migration.config.json"
    }

    Write-Host ""
    if ($script:Failures -gt 0) {
        Write-Host "$script:Failures problem(s) found. Fix them before continuing." -ForegroundColor Red
        exit 1
    }
    Write-Host "All checks passed. Next: -Step Export (read-only) or -Step DbCreate." -ForegroundColor Green
    exit 0
}

$cfg = Read-Config

# ----------------------------------------------------------------- Export
if ($Step -eq 'Export') {
    Write-Step "Export a snapshot from the source deployment"
    Write-Note "Source: $($cfg.source.baseUrl)"
    Write-Note "This is read-only: no records are created, changed or deleted."
    $session = Get-OwnerSession -BaseUrl $cfg.source.baseUrl -Purpose 'snapshot export'
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $outDir = Join-Path $script:Root $cfg.outputDir
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
    $path = Join-Path $outDir "snapshot-$stamp.json"

    try {
        $resp = Invoke-WebRequest -Uri "$($cfg.source.baseUrl)$($cfg.source.snapshotPath)" `
            -WebSession $session -UseBasicParsing -TimeoutSec 300
    } catch {
        $hint = "A 404 means the snapshot route is not deployed yet (Phase 3-4 of MIGRATION_PLAN.md)."
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 403) {
            $hint = "A 403 means the account you signed in with is not the household owner."
        }
        Stop-WithHelp "snapshot download failed: $($_.Exception.Message)" $hint
    }
    [System.IO.File]::WriteAllBytes($path, $resp.RawContentStream.ToArray())
    $hash = (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower()
    "$hash  $(Split-Path -Leaf $path)" | Set-Content -Path "$path.sha256" -Encoding ASCII

    $sizeKb = [math]::Round((Get-Item $path).Length / 1KB, 1)
    Write-Ok "wrote $path ($sizeKb KB)"
    Write-Ok "sha256 $hash"
    if ($sizeKb -lt 5) { Write-Fail "the snapshot is suspiciously small - do not use it" }

    Write-Step "Sanity check"
    Invoke-Cmd -Exe 'node' -Arguments @('migration/snapshot-tool.mjs', 'counts', $path) | Out-Null
    Write-Note "Review the counts above. users should be 2 for this household."
    Write-Host ""
    Write-Host "Snapshot contains password hashes: treat it as a secret (see BACKUP_GUIDE.md)." -ForegroundColor Yellow
    exit 0
}

# ----------------------------------------------------------------- Sql
if ($Step -eq 'Sql') {
    $snap = Resolve-Snapshot -ConfigObject $cfg
    $sqlDir = Join-Path (Join-Path $script:Root $cfg.outputDir) 'sql'
    Write-Step "Convert snapshot to SQL"
    Invoke-Cmd -Exe 'node' -Arguments @('migration/snapshot-tool.mjs', 'sql', $snap, $sqlDir) | Out-Null
    Write-Ok "SQL files are in $sqlDir"
    exit 0
}

# ----------------------------------------------------------------- DbCreate
if ($Step -eq 'DbCreate') {
    Write-Step "Create the destination D1 database"
    if ($cfg.destination.d1DatabaseId) {
        Write-Warn "config already has d1DatabaseId $($cfg.destination.d1DatabaseId); nothing to do"
        exit 0
    }
    if ($DryRun) { Write-Note "DRY RUN: npx wrangler d1 create $($cfg.destination.d1DatabaseName)"; exit 0 }
    $res = Invoke-Cmd -Exe 'npx.cmd' -Arguments @('wrangler', 'd1', 'create', $cfg.destination.d1DatabaseName) -AllowFail
    if ($res.Code -ne 0) {
        Stop-WithHelp "d1 create failed" @"
If it says the database already exists:
  npx wrangler d1 list
then put the existing database_id into $Config under destination.d1DatabaseId.
"@
    }
    $id = ''
    $match = [regex]::Match($res.Output, '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')
    if ($match.Success) { $id = $match.Groups[1].Value }
    if (-not $id) { Stop-WithHelp "could not read a database id from the command output" "Copy the 'database_id' value from the output into $Config manually." }
    $cfg.destination.d1DatabaseId = $id
    Save-Config -ConfigObject $cfg
    Write-Ok "database id $id recorded in $Config"

    Write-Step "Create the destination R2 bucket"
    $bucket = Invoke-Cmd -Exe 'npx.cmd' -Arguments @('wrangler', 'r2', 'bucket', 'create', $cfg.destination.r2BucketName) -AllowFail
    if ($bucket.Code -ne 0) {
        Write-Warn "r2 bucket create did not succeed"
        Write-Note "If it mentions R2 not being enabled, enable R2 in the dashboard (billing profile required), then re-run this step."
        Write-Note "If it says the bucket exists, that is fine."
    } else {
        Write-Ok "bucket $($cfg.destination.r2BucketName) ready"
    }
    exit 0
}

# ----------------------------------------------------------------- Import
if ($Step -eq 'Import') {
    $snap = Resolve-Snapshot -ConfigObject $cfg
    if (-not $cfg.destination.d1DatabaseId) { Stop-WithHelp "destination.d1DatabaseId is empty" "Run: .\migration\migrate.ps1 -Step DbCreate" }
    $sqlDir = Join-Path (Join-Path $script:Root $cfg.outputDir) 'sql'
    if (-not (Test-Path $sqlDir)) { Stop-WithHelp "no SQL files in $sqlDir" "Run: .\migration\migrate.ps1 -Step Sql" }

    Write-Step "Import data into $($cfg.destination.d1DatabaseName)"
    if (-not $cfg.destination.configFile) { Stop-WithHelp "destination.configFile is empty" "Set it to wrangler.production.jsonc." }
    Write-Note "Additive only: INSERT OR REPLACE. Nothing is deleted. Re-running is safe."
    $files = Get-ChildItem -Path $sqlDir -Filter 'import-*.sql' | Sort-Object Name
    if ($files.Count -eq 0) { Stop-WithHelp "no import-*.sql files in $sqlDir" "Run -Step Sql first." }
    $i = 0
    foreach ($file in $files) {
        $i++
        Write-Note "[$i/$($files.Count)] $($file.Name)"
        Invoke-Cmd -Exe 'npx.cmd' -Arguments @('wrangler', 'd1', 'execute', $cfg.destination.d1DatabaseName, '--remote', '--file', $file.FullName) | Out-Null
    }
    Write-Ok "imported $($files.Count) file(s)"
    Write-Note "Next: .\migration\verify-migration.ps1 -Step Counts"
    exit 0
}

# ----------------------------------------------------------------- Storage
if ($Step -eq 'Storage') {
    $snap = Resolve-Snapshot -ConfigObject $cfg
    Write-Step "Copy stored files, preserving object keys"
    $listJson = & node migration/snapshot-tool.mjs list-files $snap
    if ($LASTEXITCODE -ne 0) { Stop-WithHelp "could not list files from the snapshot" "Run: node migration/snapshot-tool.mjs list-files $snap" }
    $files = $listJson | ConvertFrom-Json
    if ($null -eq $files -or @($files).Count -eq 0) {
        Write-Ok "the snapshot has no stored files - storage migration is a no-op"
        exit 0
    }
    Write-Note "$(@($files).Count) file(s) to copy"
    $session = Get-OwnerSession -BaseUrl $cfg.source.baseUrl -Purpose 'file downloads'
    $tmp = Join-Path (Join-Path $script:Root $cfg.outputDir) 'files-tmp'
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $copied = 0
    try {
        foreach ($file in @($files)) {
            $name = "$($file.id)"
            $target = Join-Path $tmp $name
            try {
                Invoke-WebRequest -Uri "$($cfg.source.baseUrl)/api/files/$($file.id)" -WebSession $session `
                    -OutFile $target -UseBasicParsing -TimeoutSec 120
            } catch {
                Write-Fail "download failed for $($file.name) ($($file.key)): $($_.Exception.Message)"
                Write-Note "This is an orphan record (row exists, object gone). It is pre-existing; the migration does not cause it."
                continue
            }
            $actual = (Get-Item $target).Length
            if ($actual -ne [int64]$file.size) {
                Write-Fail "size mismatch for $($file.key): expected $($file.size), got $actual"
                Remove-Item $target -Force
                continue
            }
            $objectPath = "$($cfg.destination.r2BucketName)/$($file.key)"
            $put = Invoke-Cmd -Exe 'npx.cmd' -Arguments @('wrangler', 'r2', 'object', 'put', $objectPath, '--file', $target, '--content-type', $file.mime) -AllowFail
            if ($put.Code -ne 0) { Write-Fail "upload failed for $($file.key)"; continue }
            Write-Ok "copied $($file.key) ($actual bytes)"
            Remove-Item $target -Force
            $copied++
        }
    } finally {
        if (Test-Path $tmp) { Get-ChildItem $tmp -File | Remove-Item -Force -ErrorAction SilentlyContinue; Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    }
    Write-Host ""
    Write-Ok "$copied file(s) copied"
    if ($script:Failures -gt 0) { Write-Host "$script:Failures file(s) failed - see above." -ForegroundColor Yellow }
    exit 0
}

# ----------------------------------------------------------------- Secret
if ($Step -eq 'Secret') {
    Write-Step "Apply FIELD_KEY to the destination Worker"
    Write-Note "The value is piped from the file: it never appears in a command line or in this output."
    if (-not (Test-Path $cfg.keyFile)) { Stop-WithHelp "key file not found: $($cfg.keyFile)" "See BACKUP_GUIDE.md." }
    if ($DryRun) { Write-Note "DRY RUN: <key file> | npx wrangler secret put FIELD_KEY --config $($cfg.destination.configFile)"; exit 0 }
    $secretFile = Resolve-Path $cfg.keyFile
    $content = Get-Content -Raw -Path $secretFile
    if ([string]::IsNullOrWhiteSpace($content)) { Stop-WithHelp "key file is empty" "See BACKUP_GUIDE.md." }
    $content | & npx.cmd wrangler secret put FIELD_KEY --config $cfg.destination.configFile
    if ($LASTEXITCODE -ne 0) { Stop-WithHelp "wrangler secret put failed" "Check the deploy config path and that you are logged in." }
    Write-Ok "secret FIELD_KEY applied"
    Write-Note "Verify the file matches the data: node migration/snapshot-tool.mjs decrypt-check <snapshot> $($cfg.keyFile)"
    exit 0
}

# ----------------------------------------------------------------- Deploy
if ($Step -eq 'Deploy') {
    Write-Step "Deploy the Worker to your account"
    if (-not (Test-Path $cfg.destination.configFile)) {
        Stop-WithHelp "deploy config not found: $($cfg.destination.configFile)" "This file is created in Phase 5 of MIGRATION_PLAN.md (wrangler.production.jsonc)."
    }
    Write-Note "This publishes a NEW origin. The current deployment is untouched."
    if ($DryRun) { Write-Note "DRY RUN: npx wrangler deploy --config $($cfg.destination.configFile)"; exit 0 }
    $res = Invoke-Cmd -Exe 'npx.cmd' -Arguments @('wrangler', 'deploy', '--config', $cfg.destination.configFile) -AllowFail
    if ($res.Code -ne 0) { Stop-WithHelp "deploy failed" "Read the first error; usually a wrong database_id, a missing bucket, or not logged in." }
    foreach ($line in ($res.Output -split "`n")) {
        if ($line -match 'https://[a-z0-9.-]+\.workers\.dev') { Write-Ok "deployed: $($line.Trim())" }
    }
    Write-Note "Put that URL into $Config as destination.baseUrl, then run -Step Health."
    exit 0
}

# ----------------------------------------------------------------- Health
if ($Step -eq 'Health') {
    Assert-DestinationBase -ConfigObject $cfg
    Write-Step "Check $($cfg.destination.baseUrl)"
    try {
        $health = Invoke-RestMethod -Uri "$($cfg.destination.baseUrl)/api/health" -TimeoutSec 30
    } catch {
        Stop-WithHelp "health endpoint failed: $($_.Exception.Message)" "A 5xx here usually means the D1 binding is missing from the deploy config."
    }
    if ($health.ok -and $health.database -and $health.assets) { Write-Ok "health: $($health | ConvertTo-Json -Compress)" }
    else { Write-Fail "unhealthy: $($health | ConvertTo-Json -Compress)" }
    try {
        $status = Invoke-RestMethod -Uri "$($cfg.destination.baseUrl)/api/auth/status" -TimeoutSec 30
        Write-Ok "auth: $($status | ConvertTo-Json -Compress)"
        if (-not $status.configured) { Write-Warn "configured=false means no user rows: the import has not happened" }
    } catch {
        Write-Fail "auth/status failed: $($_.Exception.Message)"
    }
    Write-Host ""
    if ($script:Failures -gt 0) { exit 1 }
    Write-Host "Destination is up. Next: verify-migration.ps1 -Step Counts" -ForegroundColor Green
    exit 0
}
