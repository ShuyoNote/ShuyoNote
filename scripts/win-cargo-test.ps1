<#
win-cargo-test.ps1 -- run the Rust test binary on Windows.

WHY THIS EXISTS
  `cargo test` on Windows used to die at load time with
      0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND
  while the app binary (shuyonote.exe) ran fine and its import table was a
  strict superset of the test binary's.  The cause is not a missing DLL, not
  the CRT flavour, and not PATH: cargo links the generated test exe WITHOUT
  the application manifest that declares the Microsoft.Windows.Common-Controls
  v6 dependency, so the loader binds the legacy comctl32 and the imports that
  only v6 exports fail to resolve.

WHAT THIS DOES
  1. builds the test exe        cargo test --no-run --manifest-path src-tauri/Cargo.toml --lib [--release]
  2. copies it next to itself   <name>-v6.exe   (same dir, so DLL search works)
  3. injects a v6 manifest      mt.exe -manifest <tmp> -outputresource:<copy>;1
  4. runs the copy              and forwards its exit code

  The crate lives in src-tauri/, so the cargo invocation mirrors scripts/lib/gates.mjs
  (`cargo test --manifest-path src-tauri/Cargo.toml`).

  Nothing tracked in the repo is modified; the manifested copy lives under
  target/ (git ignored).  Only the lib test target is run here: the 34
  plugins::tests cases need a real host binary, so the authoritative full run
  still belongs to CI / WSL2 (see docs/TESTING.md).

USAGE
  powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1
  powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1 -Filter storage::
  powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1 -Filter storage:: -ExtraArgs --nocapture
  powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1 -Release
  powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1 -NoRun   # build + inject only
  powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1 -CargoArgs '--features','sm-crypto'
#>
[CmdletBinding()]
param(
  [switch]$Release,
  [string]$Filter = "",
  [string[]]$ExtraArgs = @(),
  [string[]]$CargoArgs = @(),
  [switch]$NoRun
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message, [int]$Code = 1) {
  Write-Host ""
  Write-Host "win-cargo-test: ERROR: $Message" -ForegroundColor Red
  exit $Code
}

function Find-MtExe {
  if ($env:MT_EXE -and (Test-Path -LiteralPath $env:MT_EXE)) { return $env:MT_EXE }
  $cmd = Get-Command 'mt.exe' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $roots = @()
  if (${env:ProgramFiles(x86)}) { $roots += (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin') }
  if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles 'Windows Kits\10\bin') }

  $cands = @()
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $dirs = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue
    foreach ($dir in $dirs) {
      $p = Join-Path $dir.FullName 'x64\mt.exe'
      if (Test-Path -LiteralPath $p) {
        $ver = [version]'0.0'
        [void][version]::TryParse($dir.Name, [ref]$ver)
        $cands += [pscustomobject]@{ Path = $p; Ver = $ver }
      }
    }
  }
  if ($cands.Count -eq 0) { return $null }
  return ($cands | Sort-Object -Property Ver -Descending | Select-Object -First 1).Path
}

$root = Split-Path -Parent $PSScriptRoot
$crateRel = 'src-tauri\Cargo.toml'
if (-not (Test-Path -LiteralPath (Join-Path $root $crateRel))) {
  if (Test-Path -LiteralPath (Join-Path $root 'Cargo.toml')) {
    $crateRel = 'Cargo.toml'
  } else {
    Fail "crate manifest not found under $root (looked for src-tauri\Cargo.toml)"
  }
}
$crateDir = Split-Path -Parent (Join-Path $root $crateRel)

$mt = Find-MtExe
if (-not $mt) {
  Fail @"
mt.exe not found. It ships with the Windows SDK (10.0.26100.0 is known good):
    C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\mt.exe
Install the "Windows SDK" component of the Visual Studio Build Tools, or point
MT_EXE at an existing copy.
"@
}

if (-not $env:OPENSSL_DIR) {
  Write-Host "win-cargo-test: note: OPENSSL_DIR is not visible in this shell (inherited user env is enough if cargo links)." -ForegroundColor Yellow
}

$profile = if ($Release) { 'release' } else { 'debug' }
$cargoArgs = @('test', '--no-run', '--manifest-path', $crateRel, '--lib') + $CargoArgs
if ($Release) { $cargoArgs += '--release' }

Write-Host "win-cargo-test: root    = $root"
Write-Host "win-cargo-test: crate   = $crateRel"
Write-Host "win-cargo-test: mt.exe  = $mt"
Write-Host "win-cargo-test: cargo   = $($cargoArgs -join ' ')"
Write-Host ""

Push-Location $root
try {
  $log = Join-Path $env:TEMP ("win-cargo-test-{0}.log" -f $PID)
  # NOTE: PowerShell 5.1 converts *native stderr* into ErrorRecords, which
  # terminate the script under ErrorActionPreference=Stop even when the output
  # is redirected to a file.  Cargo prints its progress on stderr, so relax the
  # preference for this call and decide by the exit code instead.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & cargo @cargoArgs *> $log
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
  $out = @(Get-Content -LiteralPath $log)
  if ($code -ne 0) {
    Write-Host "--- cargo output (tail) ---"
    $out | Select-Object -Last 25 | ForEach-Object { Write-Host $_ }
    if ($out -match 'OPENSSL_DIR') {
      Write-Host "win-cargo-test: hint: this build wants OPENSSL_DIR / OPENSSL_INCLUDE_DIR / OPENSSL_LIB_DIR (OpenSSL-Win64; see docs/TESTING.md)." -ForegroundColor Yellow
    }
    Fail "cargo test --no-run failed with exit code $code (full log: $log)" $code
  }

  $exe = $null
  $hit = $out | Select-String -Pattern 'Executable unittests .*\((.+?\.exe)\)' | Select-Object -Last 1
  if ($hit) {
    $exe = $hit.Matches[0].Groups[1].Value
    if (-not [System.IO.Path]::IsPathRooted($exe)) { $exe = Join-Path $root $exe }
  }
  if ($exe -and (Test-Path -LiteralPath $exe)) {
    Write-Host "win-cargo-test: test exe = $exe"
  } else {
    $deps = Join-Path $crateDir "target\$profile\deps"
    $fallback = Get-ChildItem -LiteralPath $deps -Filter 'shuyonote_lib-*.exe' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike '*-v6.exe' } |
      Sort-Object -Property LastWriteTime -Descending |
      Select-Object -First 1
    if (-not $fallback) { Fail "could not locate the test exe (looked in $deps)" }
    $exe = $fallback.FullName
    Write-Host "win-cargo-test: test exe = $exe (recovered from target\$profile\deps)"
  }
} finally {
  Pop-Location
}

$dir = Split-Path -Parent $exe
$base = Split-Path -Leaf $exe
$stamp = Get-Date -Format 'HHmmss'

# Every run leaves a 60+ MB copy behind.  Drop stale ones first (best effort:
# a copy that was just executed is sometimes still held by antivirus).
Get-ChildItem -LiteralPath $dir -Filter '*-v6*.exe' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

# Always use a *fresh* path: re-injecting into a copy that has already been
# executed makes mt.exe fail with c101008d ("the system cannot open the device
# or file specified"), which is not a permissions problem.
function New-ManifestCopy([int]$Attempt) {
  $suffix = if ($Attempt -eq 1) { "-v6-$stamp" } else { "-v6-$stamp-$Attempt" }
  $target = Join-Path $dir ($base -replace '\.exe$', "$suffix.exe")
  Copy-Item -LiteralPath $exe -Destination $target -Force
  Set-ItemProperty -LiteralPath $target -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue
  return $target
}

$copy = New-ManifestCopy 1

$manifest = Join-Path $env:TEMP ("win-cargo-test-{0}.manifest" -f $PID)
@'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"
                        version="6.0.0.0" processorArchitecture="*"
                        publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
'@ | Set-Content -LiteralPath $manifest -Encoding ASCII

Write-Host "win-cargo-test: injecting v6 manifest into $(Split-Path -Leaf $copy)"
Set-ItemProperty -LiteralPath $copy -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue

# A freshly written 60+ MB exe is often still being scanned by antivirus and
# mt.exe then fails with "c101008d ... access denied".  Re-copy and retry.
$injected = $false
$mtCode = 1
for ($attempt = 1; $attempt -le 3; $attempt++) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $mt -nologo -manifest $manifest "-outputresource:$copy;1"
    $mtCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($mtCode -eq 0) { $injected = $true; break }
  if ($attempt -lt 3) {
    Write-Host "win-cargo-test: mt.exe attempt $attempt failed (exit $mtCode), retrying on a fresh copy" -ForegroundColor Yellow
    Start-Sleep -Seconds 2
    $copy = New-ManifestCopy ($attempt + 1)
  }
}
if (-not $injected) {
  Fail "mt.exe could not update $copy (exit $mtCode) -- antivirus locking is the usual cause; retry, or exclude src-tauri\target from real-time scanning"
}

# Evidence that the injection actually landed (a stale exe would stay green).
$bytes = [System.IO.File]::ReadAllBytes($copy)
$asText = [System.Text.Encoding]::ASCII.GetString($bytes)
if ($asText -notmatch 'Common-Controls') {
  Fail "manifest does not appear in $copy -- injection did not land"
}
Write-Host "win-cargo-test: manifest present in the copy (verified by byte scan)"

if ($NoRun) {
  Write-Host "win-cargo-test: -NoRun set, not executing."
  exit 0
}

$exeArgs = @()
if ($Filter) { $exeArgs += $Filter }
if ($ExtraArgs.Count -gt 0) { $exeArgs += $ExtraArgs }

Write-Host "win-cargo-test: running $copy $($exeArgs -join ' ')"
Write-Host ""
& $copy @exeArgs
$testCode = $LASTEXITCODE
Write-Host ""
Write-Host "win-cargo-test: test exe exit code = $testCode"
exit $testCode
