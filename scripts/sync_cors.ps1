# Sync Hermes Extension CORS origins to current pinned ID
# Usage: powershell -ExecutionPolicy Bypass -File scripts/sync_cors.ps1
# Optionally pass explicit extension ID: scripts/sync_cors.ps1 -ExtensionId chrome-extension://xxxx

param(
  [string]$ExtensionId = ""
)

$ErrorActionPreference = "Stop"

# Derive ID from manifest key if not passed
if (-not $ExtensionId) {
  $manifestPath = Join-Path $PSScriptRoot "..\manifest.json"
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.key) {
    # Chromium ID = 32-char a-p from SHA256 of DER public key (first 16 bytes)
    Add-Type -AssemblyName System.Security
    $b64 = $manifest.key
    $der = [Convert]::FromBase64String($b64)
    $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($der)[0..15]
    $hex = ($sha | ForEach-Object { $_.ToString("x2") }) -join ""
    $id = ($hex.ToCharArray() | ForEach-Object { [char]([int][char]'a' + [Convert]::ToInt32($_,16)) }) -join ""
    $ExtensionId = "chrome-extension://$id"
    Write-Host "Derived pinned ID from manifest key: $ExtensionId" -ForegroundColor Cyan
  } else {
    Write-Host "manifest.json has no 'key' field. Pass -ExtensionId manually from chrome://extensions." -ForegroundColor Yellow
    Write-Host "Example: .\scripts\sync_cors.ps1 -ExtensionId chrome-extension://abcd..." -ForegroundColor Yellow
    exit 1
  }
}

if ($ExtensionId -notmatch "^chrome-extension://[a-p]{32}$") {
  Write-Warning "ID format looks unusual: $ExtensionId (expected chrome-extension:// + 32 chars a-p)"
}

$envFiles = @(
  "$env:LOCALAPPDATA\hermes\.env",
  "$env:APPDATA\hermes\.env",
  "$env:USERPROFILE\.hermes\.env"
)

$found = $false
foreach ($envFile in $envFiles) {
  if (Test-Path $envFile) {
    $content = Get-Content $envFile -Raw
    if ($content -match "API_SERVER_CORS_ORIGINS=") {
      if ($content -notmatch [regex]::Escape($ExtensionId)) {
        # PowerShell 5.1 compat: -replace with scriptblock is PS6+ only
        $matched = $content -match "API_SERVER_CORS_ORIGINS=(.*)"
        $existing = if ($matched) { $Matches[1] } else { "" }
        if ([string]::IsNullOrWhiteSpace($existing)) {
          $newLine = "API_SERVER_CORS_ORIGINS=$ExtensionId"
        } else {
          $newLine = "API_SERVER_CORS_ORIGINS=$($existing.Trim()),$ExtensionId"
        }
        $newContent = $content -replace "API_SERVER_CORS_ORIGINS=.*", $newLine
        Set-Content -Path $envFile -Value $newContent.Trim() -NoNewline
        Write-Host "Updated $envFile" -ForegroundColor Green
        Get-Content $envFile | Select-String "API_SERVER_CORS_ORIGINS"
      } else {
        Write-Host "Already present in $envFile" -ForegroundColor Green
      }
      $found = $true
    } else {
      Add-Content -Path $envFile -Value "`nAPI_SERVER_CORS_ORIGINS=$ExtensionId"
      Write-Host "Added to $envFile" -ForegroundColor Green
      $found = $true
    }
  }
}

if (-not $found) {
  Write-Warning "No Hermes .env found. Checked: $($envFiles -join ', ')"
  exit 1
}

Write-Host "`nDone. Now restart gateway: hermes gateway restart" -ForegroundColor Cyan
Write-Host "Then in extension Settings: Test connection -> Save" -ForegroundColor Cyan
