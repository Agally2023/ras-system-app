# Starts the RAS Hatchery app on this computer and opens it in its own window. No Node or other software needed (Windows 10/11).
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'app'))
$port = 8080
$url = "http://localhost:$port/"
$mime = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript'; '.mjs'='text/javascript'; '.css'='text/css'; '.svg'='image/svg+xml'; '.json'='application/json'; '.webmanifest'='application/manifest+json'; '.png'='image/png'; '.jpg'='image/jpeg'; '.ico'='image/x-icon'; '.woff'='font/woff'; '.woff2'='font/woff2'; '.txt'='text/plain' }

function Open-App {
  $edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
  $chrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
  $chrome86 = Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'
  foreach ($b in @($edge, $chrome, $chrome86)) { if (Test-Path $b) { Start-Process $b "--app=$url"; return } }
  Start-Process $url
}

$l = New-Object System.Net.HttpListener
$l.Prefixes.Add($url)
try { $l.Start() } catch { Open-App; exit 0 }   # already running: just open a window
Open-App

while ($l.IsListening) {
  $c = $l.GetContext()
  try {
    $p = [Uri]::UnescapeDataString($c.Request.Url.AbsolutePath).TrimStart('/')
    if ($p -eq '') { $p = 'index.html' }
    $f = [IO.Path]::GetFullPath((Join-Path $root $p))
    if ($f.StartsWith($root) -and (Test-Path $f -PathType Leaf)) {
      $bytes = [IO.File]::ReadAllBytes($f)
      $ext = [IO.Path]::GetExtension($f).ToLower()
      $c.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $c.Response.ContentLength64 = $bytes.Length
      $c.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else { $c.Response.StatusCode = 404 }
  } catch { $c.Response.StatusCode = 500 }
  $c.Response.Close()
}
