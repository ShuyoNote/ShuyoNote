# ShuyoNote 启动脚本：自动设置 libsqlite3-sys 编译所需的 OpenSSL 环境变量，再启动 tauri dev。
# 用法：在项目根目录运行  ./dev.ps1  或  powershell -ExecutionPolicy Bypass -File dev.ps1
$ErrorActionPreference = "Stop"

# 常见 OpenSSL-Win64 安装根；找不到就提示手动指定 OPENSSL_DIR。
$candidates = @(
  "C:\Program Files\OpenSSL-Win64",
  "C:\Program Files\OpenSSL",
  "$env:LOCALAPPDATA\Programs\OpenSSL"
)
$openssl = $candidates | Where-Object { Test-Path (Join-Path $_ "include\openssl\ssl.h") } | Select-Object -First 1
if (-not $openssl) {
  Write-Error "未找到 OpenSSL。请安装 OpenSSL-Win64，或手动执行：`n  `$env:OPENSSL_DIR='你的OpenSSL路径'; pnpm tauri dev"
  exit 1
}

$env:OPENSSL_DIR = $openssl
# 把 OpenSSL 的静态库目录加进链接器搜索路径（debug=MDd / release=MD）。
$libDirs = @(
  (Join-Path $openssl "lib\VC\x64\MDd"),
  (Join-Path $openssl "lib\VC\x64\MD")
)
$env:LIB = (($libDirs | Where-Object { Test-Path $_ }) -join ";") + ";" + $env:LIB

Write-Host "OPENSSL_DIR = $env:OPENSSL_DIR"
Write-Host "LIB         = $env:LIB"
Write-Host "启动 pnpm tauri dev ..."

Set-Location $PSScriptRoot
& pnpm tauri dev
