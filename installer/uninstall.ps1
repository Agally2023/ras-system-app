$dest = Join-Path $env:LOCALAPPDATA 'RAS-Hatchery'
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*RAS-Hatchery*start.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
foreach ($d in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Startup')) { Remove-Item (Join-Path $d 'RAS Hatchery.lnk') -Force -ErrorAction SilentlyContinue }
Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'RAS Hatchery removed.'
