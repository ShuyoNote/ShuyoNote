# ShuyoNote dev launcher: auto-set OPENSSL_DIR/LIB for libsqlite3-sys, then run pnpm tauri dev.
# Usage: run ./dev.ps1 in the project root (or: powershell -ExecutionPolicy Bypass -File dev.ps1)
$ErrorActionPreference = "Stop"

# Common OpenSSL-Win64 install roots. If none found, set OPENSSL_DIR manually.
$candidates = @(
  "C:\Program Files\OpenSSL-Win64",
  "C:\Program Files\OpenSSL",
  "$env:LOCALAPPDATA\Programs\OpenSSL"
)
$openssl = $candidates | Where-Object { Test-Path (Join-Path $_ "include\openssl\ssl.h") } | Select-Object -First 1
if (-not $openssl) {
  Write-Error "OpenSSL not found. Install OpenSSL-Win64 or set OPENSSL_DIR, then rerun this script."
  exit 1
}

$env:OPENSSL_DIR = $openssl
$libDirs = @(
  (Join-Path $openssl "lib\VC\x64\MDd"),
  (Join-Path $openssl "lib\VC\x64\MD")
)
$env:LIB = (($libDirs | Where-Object { Test-Path $_ }) -join ";") + ";" + $env:LIB

Write-Host "OPENSSL_DIR = $env:OPENSSL_DIR"
Write-Host "LIB         = $env:LIB"
Write-Host "Starting pnpm tauri dev ..."

Set-Location $PSScriptRoot
& pnpm tauri dev
