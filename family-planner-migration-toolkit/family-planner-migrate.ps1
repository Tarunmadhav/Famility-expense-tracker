# Family Finance Planner migration helper
# Safe-by-default: this script never deletes or modifies the old Freebuff deployment.
# Run from PowerShell in the cloned repository directory.
#
# Examples:
#   .\family-planner-migrate.ps1 -Stage Check
#   .\family-planner-migrate.ps1 -Stage Prepare
#   .\family-planner-migrate.ps1 -Stage Provision
#   .\family-planner-migrate.ps1 -Stage ImportDatabase -SqlFile ".\backups\freebuff-export.sql"
#   .\family-planner-migrate.ps1 -Stage Deploy
#
# IMPORTANT:
# - Do not run ImportDatabase until you have a FULL D1 SQL export from Freebuff.
# - Do not deploy until the original FIELD_KEY is safely available and data/files are migrated.
# - R2 object transfer is intentionally not automated until we know which export method
#   Freebuff provides (S3 credentials, downloadable archive, or dashboard export).

[CmdletBinding()]
param(
    [ValidateSet("Check", "Prepare", "Provision", "ImportDatabase", "SetFieldKey", "Deploy")]
    [string]$Stage = "Check",
    [string]$SqlFile
)

$ErrorActionPreference = "Stop"
$WorkerName = "family-finance-planner"
$DatabaseName = "family-planner-db"
$BucketName = "family-planner-drive"

function Stop-WithMessage([string]$Message) {
    Write-Host "`nSTOP: $Message" -ForegroundColor Red
    exit 1
}

function Require-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Stop-WithMessage "$Name is not installed. $InstallHint"
    }
}

function Invoke-Checked([string]$Exe, [string[]]$Args) {
    Write-Host "`n> $Exe $($Args -join ' ')" -ForegroundColor Cyan
    & $Exe @Args
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage "Command failed with exit code $LASTEXITCODE: $Exe $($Args -join ' ')"
    }
}

function Get-ProjectRoot {
    if (-not (Test-Path ".\package.json") -or -not (Test-Path ".\wrangler.jsonc")) {
        Stop-WithMessage "Open PowerShell in the Famility-expense-tracker repository root (the folder containing package.json and wrangler.jsonc)."
    }
    return (Get-Location).Path
}

function Read-Config {
    $raw = Get-Content ".\wrangler.jsonc" -Raw
    try { return ($raw | ConvertFrom-Json) }
    catch { Stop-WithMessage "wrangler.jsonc could not be parsed as JSON. Make a copy before editing it." }
}

function Save-Config($Config) {
    $Config | ConvertTo-Json -Depth 50 | Set-Content ".\wrangler.jsonc" -Encoding UTF8
    Write-Host "Updated wrangler.jsonc (a backup was created first)." -ForegroundColor Green
}

function Ensure-ConfigBackup {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item ".\wrangler.jsonc" ".\wrangler.jsonc.backup-$stamp"
}

Get-ProjectRoot | Out-Null
Require-Command "node" "Install Node.js 22 LTS from https://nodejs.org/"
Require-Command "npm" "Install Node.js 22 LTS from https://nodejs.org/"
Require-Command "git" "Install Git from https://git-scm.com/downloads/"
Require-Command "npx" "Reinstall Node.js if npm/npx are missing."

Write-Host "`nFamily Finance Planner migration helper" -ForegroundColor Green
Write-Host "Project: $((Get-Location).Path)"
Write-Host "Stage:   $Stage"

switch ($Stage) {
    "Check" {
        Write-Host "`nChecking local tools..."
        node --version
        npm --version
        git --version
        if (Test-Path ".\node_modules\.bin\wrangler.cmd") {
            Write-Host "Local Wrangler dependency: present" -ForegroundColor Green
        } else {
            Write-Host "Local Wrangler dependency: not installed yet (Prepare stage installs it)." -ForegroundColor Yellow
        }
        Write-Host "`nChecking repository state..."
        git status --short
        Write-Host "`nNo cloud resources or production data have been changed."
    }

    "Prepare" {
        Write-Host "`nInstalling exact dependencies from package-lock.json..."
        Invoke-Checked "npm" @("ci")
        Write-Host "`nBuilding the website and Worker..."
        Invoke-Checked "npm" @("run", "build")
        Write-Host "`nPreparation complete. This has not deployed anything." -ForegroundColor Green
    }

    "Provision" {
        if (-not (Test-Path ".\node_modules\.bin\wrangler.cmd")) {
            Stop-WithMessage "Run .\family-planner-migrate.ps1 -Stage Prepare first."
        }

        Write-Host "`nChecking Cloudflare login..."
        & npx wrangler whoami
        if ($LASTEXITCODE -ne 0) {
            Write-Host "You need to log in. A browser will open." -ForegroundColor Yellow
            Invoke-Checked "npx" @("wrangler", "login")
            Invoke-Checked "npx" @("wrangler", "whoami")
        }

        $config = Read-Config
        $existingId = [string]$config.d1_databases[0].database_id

        if ([string]::IsNullOrWhiteSpace($existingId) -or $existingId -match "^0{8}-0{4}-0{4}-0{4}-0{12}$") {
            Write-Host "`nCreating a NEW destination D1 database: $DatabaseName"
            Write-Host "This does not access or change the Freebuff database."
            $createOutput = & npx wrangler d1 create $DatabaseName 2>&1
            $createOutput | ForEach-Object { Write-Host $_ }
            if ($LASTEXITCODE -ne 0) {
                Stop-WithMessage "D1 creation failed. If the database already exists, open Cloudflare > Storage & databases > D1 and copy its Database ID, then update wrangler.jsonc manually."
            }
            $joined = ($createOutput | Out-String)
            $match = [regex]::Match($joined, "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
            if (-not $match.Success) {
                Stop-WithMessage "Could not read the new D1 ID from Wrangler output. Copy the Database ID from the Cloudflare dashboard and update wrangler.jsonc manually."
            }
            Ensure-ConfigBackup
            $config.d1_databases[0].database_name = $DatabaseName
            $config.d1_databases[0].database_id = $match.Value
            # This repository initializes/updates its schema in src/store.js.
            # Do not leave a migrations_dir pointing to a folder absent from the repo.
            if ($config.d1_databases[0].PSObject.Properties.Name -contains "migrations_dir" -and
                -not (Test-Path ([string]$config.d1_databases[0].migrations_dir))) {
                $config.d1_databases[0].PSObject.Properties.Remove("migrations_dir")
            }
            Save-Config $config
        } else {
            Write-Host "wrangler.jsonc already has a non-placeholder D1 ID: $existingId"
            $answer = Read-Host "Use this configured database? Type USE to continue"
            if ($answer -cne "USE") { Stop-WithMessage "No changes made. Confirm the destination D1 database first." }
        }

        $config = Read-Config
        $bucket = [string]$config.r2_buckets[0].bucket_name
        if ([string]::IsNullOrWhiteSpace($bucket)) { $bucket = $BucketName }
        Write-Host "`nCreating/checking destination R2 bucket: $bucket"
        & npx wrangler r2 bucket create $bucket
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Bucket creation returned a non-zero code. It may already exist; verify it in Cloudflare > R2 before continuing." -ForegroundColor Yellow
            $answer = Read-Host "Have you verified that this exact bucket exists in your Cloudflare account? Type YES"
            if ($answer -cne "YES") { Stop-WithMessage "R2 bucket not verified. No deployment performed." }
        }
        if ($config.r2_buckets[0].bucket_name -ne $bucket) {
            Ensure-ConfigBackup
            $config.r2_buckets[0].bucket_name = $bucket
            Save-Config $config
        }

        Write-Host "`nDestination resources are configured in wrangler.jsonc." -ForegroundColor Green
        Write-Host "Next: obtain the full Freebuff D1 SQL export and R2 file export. Do NOT deploy yet."
    }

    "ImportDatabase" {
        if ([string]::IsNullOrWhiteSpace($SqlFile)) {
            Stop-WithMessage "Supply a full SQL export, for example: -SqlFile '.\backups\freebuff-export.sql'"
        }
        if (-not (Test-Path $SqlFile -PathType Leaf)) {
            Stop-WithMessage "SQL file not found: $SqlFile"
        }
        $resolved = (Resolve-Path $SqlFile).Path
        Write-Host "`nYou are about to import this SQL file into the REMOTE destination D1 database:"
        Write-Host $resolved -ForegroundColor Yellow
        Write-Host "This is only safe if this is a complete SQLite/D1 export from your Freebuff production database."
        Write-Host "It may contain user records, password hashes, encrypted fields and application data."
        $answer = Read-Host "Have you backed up the source and verified this is the correct full export? Type IMPORT"
        if ($answer -cne "IMPORT") { Stop-WithMessage "Import cancelled." }
        Invoke-Checked "npx" @("wrangler", "d1", "execute", $DatabaseName, "--remote", "--file", $resolved)
        Write-Host "`nSQL import command completed. Do not assume R2 files are transferred; they are a separate step." -ForegroundColor Green
    }

    "SetFieldKey" {
        Write-Host "`nThis must be the ORIGINAL production FIELD_KEY if you are importing encrypted records."
        Write-Host "Do not generate a new key for an existing encrypted database."
        $secure = Read-Host "Paste the original FIELD_KEY (input is hidden)" -AsSecureString
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
        if ([string]::IsNullOrWhiteSpace($plain)) { Stop-WithMessage "Empty FIELD_KEY; nothing was set." }
        $plain | npx wrangler secret put FIELD_KEY
        $code = $LASTEXITCODE
        $plain = $null
        if ($code -ne 0) { Stop-WithMessage "Could not set FIELD_KEY. Check Wrangler output." }
        Write-Host "FIELD_KEY submitted to Cloudflare as a Worker secret." -ForegroundColor Green
    }

    "Deploy" {
        Write-Host "`nPRE-DEPLOY SAFETY CHECK"
        Write-Host "Before deploying, confirm ALL of these:"
        Write-Host "  1. Full D1 production export imported into the destination."
        Write-Host "  2. Original FIELD_KEY set as a Worker secret."
        Write-Host "  3. R2 objects and the files metadata table have been transferred and verified."
        Write-Host "  4. wrangler.jsonc points only to your new Cloudflare resources."
        $answer = Read-Host "Have you completed all four checks? Type DEPLOY"
        if ($answer -cne "DEPLOY") { Stop-WithMessage "Deployment cancelled. Nothing deployed." }
        Invoke-Checked "npm" @("run", "build")
        Invoke-Checked "npx" @("wrangler", "deploy")
        Write-Host "`nDeployment command completed. Check the Worker URL and /api/health." -ForegroundColor Green
    }
}

Write-Host "`nReminder: keep Freebuff running until the new site, database, files, login and Android app are all verified." -ForegroundColor Yellow
