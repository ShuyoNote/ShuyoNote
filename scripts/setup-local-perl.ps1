# setup-local-perl.ps1 -- graft the few pure-Perl CPAN modules that Git-for-Windows' trimmed
# perl is missing, so that `node_modules\.bin\tauri android build` can build OpenSSL locally.
#
# WHY (2026-09-21, measured on this machine):
#   Building the Android APK on Windows needs `openssl-src` to configure+make OpenSSL, which needs
#   `perl`. This machine has no full perl distribution, and the two obvious installers are BOTH
#   dead ends because they fetch their MSI from github.com (unreachable here):
#       winget install StrawberryPerl.StrawberryPerl   -> InternetOpenUrl() failed 0x80072efd
#       choco  install strawberryperl -y               -> exited 404 (same source)
#       choco  install activeperl -y                   -> package flagged "likely broken for FOSS"
#   Git for Windows DOES ship a perl (5.38.2) but it is trimmed for git and lacks a couple of
#   modules OpenSSL's Configure needs. Those modules are pure Perl and live on CPAN, which IS
#   reachable from here (fastapi.metacpan.org / cpan.metacpan.org return 200).
#   => download just those dists, drop their lib/ into a per-user dir, and point PERL5LIB at it.
#
# USAGE
#   powershell -ExecutionPolicy Bypass -File scripts\setup-local-perl.ps1
#   ... then (same shell), or whenever you build:
#     $env:PERL5LIB = "$env:USERPROFILE\.local-perl5\lib"
#     $env:PATH     = "$env:PATH;C:\Program Files\Git\usr\bin"
#     node_modules\.bin\tauri.CMD android build --target aarch64 --apk
#
# ASCII-ONLY on purpose: PS 5.1 parses no-BOM .ps1 in the OEM codepage (see scripts/check-ps1-ascii.mjs).
[CmdletBinding()]
param(
  [string]$Lib = "$env:USERPROFILE\.local-perl5\lib",
  [string]$Perl = "C:\Program Files\Git\usr\bin\perl.exe"
)

$ErrorActionPreference = 'Stop'

# Modules OpenSSL's Configure (openssl 3.x) needs and git's perl does not carry.
# Keep this list short: everything else the chain needs (Params::Check, IPC::Cmd, File::*,
# Getopt::Long, I18N::LangTags, ...) is already in Git's perl -- verified by probing it.
$modules = @(
  'Locale::Maketext',
  'Locale::Maketext::Simple',
  'ExtUtils::MakeMaker',
  'Text::Template',
  'File::Which',
  'Pod::Usage',
  'Pod::Simple',
  'Pod::Text',
  'Pod::Man',
  'Pod::Escapes',
  'ExtUtils::Install',
  'ExtUtils::Manifest'
)

if (-not (Test-Path -LiteralPath $Perl)) { throw "perl not found: $Perl" }
New-Item -ItemType Directory -Force -Path $Lib | Out-Null
$tmp = Join-Path $env:TEMP ("perlmods-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Output "target lib : $Lib"
Write-Output "perl       : $Perl"
Write-Output "staging    : $tmp"
Write-Output ""

$failed = @()
foreach ($m in $modules) {
  try {
    $meta = Join-Path $tmp ("meta-" + ($m -replace '::', '-') + ".json")
    & curl.exe -s --max-time 30 ("https://fastapi.metacpan.org/v1/module/" + $m) -o $meta
    $json = Get-Content -LiteralPath $meta -Raw | ConvertFrom-Json
    if (-not $json.download_url) { throw "no download_url in metacpan response" }
    $tgz = Join-Path $tmp (Split-Path $json.download_url -Leaf)
    & curl.exe -sL --max-time 120 $json.download_url -o $tgz
    if ((Get-Item -LiteralPath $tgz).Length -lt 1000) { throw "download too small: $tgz" }
    & tar.exe -xzf $tgz -C $tmp
    $root = Join-Path $tmp ([System.IO.Path]::GetFileNameWithoutExtension([System.IO.Path]::GetFileNameWithoutExtension($tgz)))
    $src = Join-Path $root "lib"
    if (-not (Test-Path -LiteralPath $src)) { throw "no lib/ in $root" }
    Copy-Item -Path (Join-Path $src '*') -Destination $Lib -Recurse -Force
    # Some dists keep a second tree (ExtUtils-MakeMaker ships ExtUtils::Install / ExtUtils::Manifest
    # under bundled/lib) -- copy that too, otherwise MakeMaker is only half installed.
    $bundled = Join-Path $root "bundled\lib"
    if (Test-Path -LiteralPath $bundled) {
      Copy-Item -Path (Join-Path $bundled '*') -Destination $Lib -Recurse -Force
    }
    Write-Output ("  ok   {0,-28} {1}" -f $m, $json.version)
  } catch {
    Write-Output ("  FAIL {0,-28} {1}" -f $m, $_.Exception.Message)
    $failed += $m
  }
}

Write-Output ""
Write-Output "verify with:"
$probe = 'use IPC::Cmd; use ExtUtils::MakeMaker; use Text::Template; use Locale::Maketext::Simple; print "perl-modules-OK\n";'
$env:PERL5LIB = $Lib
& $Perl -e $probe
$exit = $LASTEXITCODE

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Output ""
Write-Output "next steps (PowerShell):"
Write-Output ("  `$env:PERL5LIB = `"$Lib`"")
Write-Output "  `$env:PATH = `"`$env:PATH;C:\Program Files\Git\usr\bin`""
Write-Output "  node_modules\.bin\tauri.CMD android build --target aarch64 --apk"

if ($failed.Count -gt 0 -or $exit -ne 0) { exit 1 }
exit 0
