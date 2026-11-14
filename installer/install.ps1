# Copies the app to %LOCALAPPDATA%\RAS-Hatchery and adds Desktop and Start Menu shortcuts.
param([switch]$AutoStart)
$ErrorActionPreference = 'Stop'
$dest = Join-Path $env:LOCALAPPDATA 'RAS-Hatchery'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'app') $dest -Recurse -Force
Copy-Item (Join-Path $PSScriptRoot 'gateway') $dest -Recurse -Force -ErrorAction SilentlyContinue
foreach ($f in 'start.ps1', 'uninstall.ps1', 'README-INSTALL.txt') { Copy-Item (Join-Path $PSScriptRoot $f) $dest -Force }
function New-Link($path) {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  $s.TargetPath = 'powershell.exe'
  $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dest\start.ps1`""
  $s.WorkingDirectory = $dest
  $s.Description = 'RAS Hatchery monitor'
  $s.Save()
}
New-Link (Join-Path ([Environment]::GetFolderPath('Desktop')) 'RAS Hatchery.lnk')
New-Link (Join-Path ([Environment]::GetFolderPath('Programs')) 'RAS Hatchery.lnk')
if ($AutoStart) { New-Link (Join-Path ([Environment]::GetFolderPath('Startup')) 'RAS Hatchery.lnk') }
Write-Host "Installed to $dest"
Write-Host 'Open "RAS Hatchery" from the Desktop.'
if ($AutoStart) { Write-Host 'It will also start when this computer starts.' }
