# Prompts for the Shopify Dev Dashboard app credentials, writes them into .env,
# then verifies the connection. Run via the "Setup Shopify.cmd" shortcut so it
# gets its own console window.
#
# The secret is read as a SecureString so it doesn't sit in console scrollback,
# and it is written only to .env (which is gitignored).

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"

Write-Host ""
Write-Host "  Esses Analytics - Shopify setup" -ForegroundColor Cyan
Write-Host "  ==============================="
Write-Host ""
Write-Host "  Get these from: Shopify Dev Dashboard > your app > Settings"
Write-Host "  (click the eye icon to reveal the secret)"
Write-Host ""

if (-not (Test-Path $envPath)) {
  Write-Host "  ERROR: .env not found at $envPath" -ForegroundColor Red
  Read-Host "  Press Enter to close"
  exit 1
}

$clientId = (Read-Host "  Client ID").Trim()
if (-not $clientId) {
  Write-Host "  No Client ID entered - nothing changed." -ForegroundColor Yellow
  Read-Host "  Press Enter to close"
  exit 1
}

$secureSecret = Read-Host "  Client secret" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
  $clientSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if (-not $clientSecret) {
  Write-Host "  No secret entered - nothing changed." -ForegroundColor Yellow
  Read-Host "  Press Enter to close"
  exit 1
}

# Basic sanity check: Dev Dashboard secrets are long hex-ish strings.
if ($clientSecret.Length -lt 20) {
  Write-Host ""
  Write-Host "  WARNING: that secret looks short ($($clientSecret.Length) chars)." -ForegroundColor Yellow
  Write-Host "  Make sure you copied the Client SECRET, not the Client ID."
  $go = Read-Host "  Continue anyway? (y/n)"
  if ($go -ne "y") { exit 1 }
}

# Replace the existing keys in place, or append if somehow absent.
$lines = Get-Content $envPath
$sawId = $false
$sawSecret = $false
$out = foreach ($line in $lines) {
  if ($line -match '^\s*SHOPIFY_CLIENT_ID\s*=') { $sawId = $true; "SHOPIFY_CLIENT_ID=$clientId" }
  elseif ($line -match '^\s*SHOPIFY_CLIENT_SECRET\s*=') { $sawSecret = $true; "SHOPIFY_CLIENT_SECRET=$clientSecret" }
  else { $line }
}
if (-not $sawId) { $out += "SHOPIFY_CLIENT_ID=$clientId" }
if (-not $sawSecret) { $out += "SHOPIFY_CLIENT_SECRET=$clientSecret" }

# UTF-8 without BOM so dotenv parses the first key correctly.
[System.IO.File]::WriteAllLines($envPath, $out, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "  Saved to .env (id $($clientId.Length) chars, secret $($clientSecret.Length) chars)." -ForegroundColor Green
Write-Host ""
Write-Host "  Verifying connection..." -ForegroundColor Cyan
Write-Host ""

# Node/pnpm may not be on this shell's PATH yet; point at them directly.
$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:Path"
Push-Location $projectRoot
try {
  & "$env:APPDATA\npm\pnpm.cmd" check:shopify
} finally {
  Pop-Location
}

Write-Host ""
Read-Host "  Press Enter to close"
