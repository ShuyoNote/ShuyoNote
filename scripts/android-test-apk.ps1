# android-test-apk.ps1 -- build an arm64 APK locally and sign it with the *test* key, so it can be
# installed over an already-installed test build (`adb install -r -d`) WITHOUT wiping app data.
#
# WHY THIS EXISTS
#   Real-device verification (two phones, LAN discovery, mesh rounds, panel UI) needs a fresh APK
#   far more often than a release does. The Android toolchain env (NDK / OpenSSL / perl / make) and
#   the signing step are the two things that go wrong every time, so they are scripted here.
#   `docs/TESTING.md` (section on the Android packaging recipe) is the source of the env vars below;
#   the release path for real users is still GitHub Actions `release.yml`.
#
# PREREQUISITES
#   * Android SDK + NDK 29.0.13846066 (paths below assume %LOCALAPPDATA%\Android\Sdk).
#   * A **test-only** keystore at %USERPROFILE%\.shuyonote-test-keystore\
#       shuyonote-test-only.jks   (alias: shuyonote-test -- NOT `shuyonote`)
#       PASSWORD.txt              (store password)
#     The two test phones already have this key installed (cert SHA-256 98128a67...), which is the
#     whole point: the same key lets `adb install -r -d` upgrade in place and keep app data
#     (spaces, sync profiles, mesh settings). A *release*-signed APK would force an uninstall.
#
# USAGE
#   powershell -ExecutionPolicy Bypass -File scripts\android-test-apk.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\android-test-apk.ps1 -UnsignedApk <path>
#       (re-sign an already-built *-unsigned.apk; skips the long build step)
#
# OUTPUT
#   tmp\android-test-apk\shuyonote-test-signed.apk   (tmp\ is git-ignored)
#
# NOTE: this file must stay PURE ASCII (scripts/check-ps1-ascii.mjs scans every .ps1 in the repo,
#       including scratch dirs): PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as ANSI and reports
#       bogus syntax errors.
[CmdletBinding()]
param(
  # Skip the Gradle/cargo build and just zipalign + sign this unsigned APK.
  [string]$UnsignedApk = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$outDir = Join-Path $root "tmp\android-test-apk"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# ---- 1. Android/NDK env (mirrors docs/TESTING.md's recipe) -------------------------------
$ndkRoot = "$env:LOCALAPPDATA\Android\Sdk\ndk\29.0.13846066"
if (-not (Test-Path $ndkRoot)) { Write-Host "[apk] NDK not found: $ndkRoot"; exit 1 }
$ndk = "$ndkRoot\toolchains\llvm\prebuilt\windows-x86_64\bin".Replace('\', '/')
$env:PERL5LIB = "$env:USERPROFILE\.local-perl5\lib"
$env:PATH = "$env:PATH;C:\Program Files\Git\usr\bin"
foreach ($v in 'CC', 'AR', 'RANLIB') {
  $tool = if ($v -eq 'CC') { 'clang' } elseif ($v -eq 'AR') { 'llvm-ar' } else { 'llvm-ranlib' }
  Set-Item "env:${v}_aarch64_linux_android" "$ndk/$tool.exe"
}
$env:TARGET_CC = "$ndk/clang.exe"; $env:TARGET_AR = "$ndk/llvm-ar.exe"; $env:TARGET_RANLIB = "$ndk/llvm-ranlib.exe"
$env:CFLAGS_aarch64_linux_android = "--target=aarch64-linux-android24"
$env:ANDROID_NDK_ROOT = $ndkRoot
$env:ANDROID_NDK_HOME = $ndkRoot
# CI sets this at job level; `beforeBuildCommand` (= pnpm build) inherits our shell env.
$env:VITE_TEST_HOOKS = "1"

# ---- 2. build (skippable) ----------------------------------------------------------------
if ($UnsignedApk) {
  $unsigned = Get-Item $UnsignedApk
  Write-Host "[apk] re-signing an existing unsigned apk: $($unsigned.FullName)"
} else {
  Write-Host "[apk] building (arm64, release, unsigned) -- first run is 35-40 min, cached 6-8 min"
  & node_modules\.bin\tauri.CMD android build --target aarch64 --apk --ci
  if ($LASTEXITCODE -ne 0) { Write-Host "[apk] tauri build FAILED ($LASTEXITCODE)"; exit 1 }
  # CAUTION (shared generated project): `src-tauri\gen\android` is ONE directory shared by every
  # worktree that builds here, and this picks the *newest* unsigned apk. Two lanes building at the
  # same time will each sign whatever the other just produced. Run one APK build at a time.
  $unsigned = Get-ChildItem -Recurse "src-tauri\gen\android\app\build\outputs\apk" -Filter "*-unsigned.apk" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $unsigned) { Write-Host "[apk] no unsigned apk found"; exit 1 }
  Write-Host "[apk] unsigned = $($unsigned.FullName) ($([math]::Round($unsigned.Length/1MB,1)) MB)"
}

$bt = Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk\build-tools" -Directory |
  Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $bt) { Write-Host "[apk] no Android build-tools found"; exit 1 }
$zipalign = Join-Path $bt.FullName "zipalign.exe"
$apksigner = Join-Path $bt.FullName "apksigner.bat"
Write-Host "[apk] build-tools = $($bt.Name)"

# ---- 3. sign with the test key -----------------------------------------------------------
$ksDir = "$env:USERPROFILE\.shuyonote-test-keystore"
$ks = "$ksDir\shuyonote-test-only.jks"
if (-not (Test-Path $ks)) { Write-Host "[apk] test keystore not found: $ks (see the header)"; exit 1 }
$pass = (Get-Content "$ksDir\PASSWORD.txt" -Raw).Trim()
$aligned = Join-Path $outDir "shuyonote-aligned.apk"
$signed = Join-Path $outDir "shuyonote-test-signed.apk"
Remove-Item $aligned, $signed -ErrorAction SilentlyContinue

& $zipalign -f -p 4 $unsigned.FullName $aligned
if ($LASTEXITCODE -ne 0) { Write-Host "[apk] zipalign FAILED"; exit 1 }
if (-not (Test-Path $aligned)) { Write-Host "[apk] zipalign reported OK but produced nothing"; exit 1 }
& $apksigner sign --ks $ks --ks-key-alias shuyonote-test --ks-pass "pass:$pass" --out $signed $aligned
if ($LASTEXITCODE -ne 0) { Write-Host "[apk] apksigner FAILED"; exit 1 }

# 2026-09-26: after signing, VERIFY the fingerprint here and fail loudly on mismatch.
# Why this guard exists (a real scene from another worktree's script log): that script passed the
# wrong key alias (the keystore only has `shuyonote-test`, it passed `shuyonote`), so apksigner
# never signed, `verify` said `Missing META-INF/MANIFEST.MF`, and the script STILL printed
# "signed = ..." and exited 0 (it never checked the sign step's exit code). The artifact was
# UNSIGNED: installing it fails, or forces an uninstall -- which wipes app data.
# This script guards BOTH: the exit codes above, and this literal fingerprint check
# (98128a67... == the test key the two phones already have installed).
$expect = "98128a67a9f62c1ca70a928f989209687ddd7682313eeb9c061a65ecd47b242a"
$certs = & $apksigner verify --print-certs $signed 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "[apk] apksigner verify FAILED (bad or unsigned apk)"; $certs | Select-Object -First 3; exit 1 }
$fp = ($certs | Select-String "SHA-256 digest" | Select-Object -First 1).Line
if ($fp -notmatch $expect) { Write-Host "[apk] fingerprint does NOT match the phones' test key: $fp"; exit 1 }
Write-Host "[apk] fingerprint OK (same test key the phones already have)"
Write-Host "[apk] install with: adb install -r -d `"$signed`""
Write-Host "[apk] DONE -> $signed"
