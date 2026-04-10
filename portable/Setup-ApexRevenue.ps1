# ═══════════════════════════════════════════════════════════════════════════════
# Apex Revenue Desktop — Setup Script
# Run ONCE after extracting the ZIP to your desired install folder.
#
# Usage (right-click → Run with PowerShell):
#   Right-click Setup-ApexRevenue.ps1 → "Run with PowerShell"
#
# Or from a terminal:
#   powershell -ExecutionPolicy Bypass -File Setup-ApexRevenue.ps1
# ═══════════════════════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ⚡ Apex Revenue Desktop — Setup" -ForegroundColor Cyan
Write-Host "  ─────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# Resolve install directory (where this script lives)
$InstallDir = $PSScriptRoot
$ExePath    = Join-Path $InstallDir "Apex Revenue.exe"

if (-not (Test-Path $ExePath)) {
    Write-Host "  ❌  Cannot find 'Apex Revenue.exe' in $InstallDir" -ForegroundColor Red
    Write-Host "     Make sure you extracted the ZIP and are running this script" -ForegroundColor Yellow
    Write-Host "     from inside the extracted folder." -ForegroundColor Yellow
    Read-Host "`n  Press Enter to exit"
    exit 1
}

# ── 1. Unblock all files (removes the 'downloaded from internet' mark) ─────────
Write-Host "  [1/3] Unblocking files…" -ForegroundColor White
Get-ChildItem -Path $InstallDir -Recurse -File | ForEach-Object {
    try { Unblock-File -Path $_.FullName } catch {}
}
Write-Host "        Done." -ForegroundColor Green

# ── 2. Desktop shortcut ────────────────────────────────────────────────────────
Write-Host "  [2/3] Creating Desktop shortcut…" -ForegroundColor White
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$WshShell    = New-Object -ComObject WScript.Shell
$Shortcut    = $WshShell.CreateShortcut("$DesktopPath\Apex Revenue.lnk")
$Shortcut.TargetPath       = $ExePath
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.Description      = "Apex Revenue — Creator Intelligence Engine"
$Shortcut.Save()
Write-Host "        $DesktopPath\Apex Revenue.lnk" -ForegroundColor Green

# ── 3. Start Menu shortcut ────────────────────────────────────────────────────
Write-Host "  [3/3] Creating Start Menu entry…" -ForegroundColor White
$StartMenuDir = Join-Path ([Environment]::GetFolderPath("Programs")) "Apex Revenue"
if (-not (Test-Path $StartMenuDir)) { New-Item -ItemType Directory -Path $StartMenuDir | Out-Null }

$StartShortcut = $WshShell.CreateShortcut("$StartMenuDir\Apex Revenue.lnk")
$StartShortcut.TargetPath       = $ExePath
$StartShortcut.WorkingDirectory = $InstallDir
$StartShortcut.Description      = "Apex Revenue — Creator Intelligence Engine"
$StartShortcut.Save()

$WebShortcut = $WshShell.CreateShortcut("$StartMenuDir\ApexRevenue.works.url")
$WebShortcut.TargetPath = "https://apexrevenue.works"
$WebShortcut.Save()
Write-Host "        $StartMenuDir\" -ForegroundColor Green

# ── Done ───────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ✅  Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Apex Revenue is ready. Launch it from your Desktop" -ForegroundColor White
Write-Host "  or Start Menu, or run directly:" -ForegroundColor White
Write-Host "  $ExePath" -ForegroundColor DarkGray
Write-Host ""

# Offer to launch now
$Launch = Read-Host "  Launch Apex Revenue now? [Y/n]"
if ($Launch -ne "n" -and $Launch -ne "N") {
    Write-Host "  Starting…" -ForegroundColor Cyan
    Start-Process $ExePath
}
