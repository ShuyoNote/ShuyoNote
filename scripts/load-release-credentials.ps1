#Requires -Version 5
<#
  Load release credentials into THIS PowerShell process (never written to disk, never echoed).

  Why this exists (2026-09-21):
    The credential file is a hand-kept .md outside the repo. Its FORMAT has changed at least once
    ("(PAT): <token>" lines -> a "visit-token: <token>" line plus a bare GitHub PAT line), and the
    ad-hoc loader broke silently: it looked for the old label, threw, and the release stopped later
    with a confusing 401. Also, GitHub now hands out FINE-GRAINED tokens (github_pat_...) which the
    old "ghp_" pattern did not match at all.

    So: one loader, both token shapes, and a -Verify switch that actually calls the two APIs --
    a 401 at publish time costs a whole release cycle, a 401 here costs two seconds.

  What it sets (only when found):
    GITCODE_TOKEN                    <token> on the visit-token line
    GH_TOKEN / GITHUB_TOKEN          github_pat_... (fine-grained) or gh[pous]_... (classic)
    TAURI_SIGNING_PRIVATE_KEY        ~/.tauri/shuyonote.key (if present)
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD  ~/.tauri/shuyonote.key.pw, else the old "(key.pw):" line

  Usage:
    . scripts/load-release-credentials.ps1 -CredPath C:\path\to\keys.md          # dot-source it
    . scripts/load-release-credentials.ps1 -CredPath C:\path\to\keys.md -Verify

  Exit codes: 0 = loaded (and verified when -Verify); 1 = a required item is missing/invalid.
  ASCII-ONLY on purpose: PS 5.1 parses no-BOM .ps1 in the OEM codepage (see scripts/check-ps1-ascii.mjs),
  so the Chinese labels in the credential file are matched by codepoint, not by literal characters.
#>
param(
  [Parameter(Mandatory = $true)][string]$CredPath,
  [switch]$Verify
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $CredPath)) { throw "credential file not found: $CredPath" }
$text = Get-Content -LiteralPath $CredPath -Raw -Encoding UTF8

function Show-Set([string]$name, [string]$value, [string]$shape) {
  if ([string]::IsNullOrEmpty($value)) { Write-Output ("  {0}: MISSING" -f $name) }
  else { Write-Output ("  {0}: set ({1}, {2} chars)" -f $name, $shape, $value.Length) }
}

# ---- GitHub PAT: fine-grained (github_pat_...) or classic (ghp_/gho_/ghu_/ghs_) ----
$gh = [regex]::Match($text, '(github_pat_[A-Za-z0-9_]{20,}|gh[pous]_[A-Za-z0-9]{20,})')
if ($gh.Success) {
  $env:GH_TOKEN = $gh.Groups[1].Value
  $env:GITHUB_TOKEN = $env:GH_TOKEN
}

# ---- GitCode PAT: the line labelled with U+8BBF U+95EE U+4EE4 U+724C (+ U+FF1A or ':') ----
$visitTokenLabel = [string]([char]0x8BBF + [char]0x95EE + [char]0x4EE4 + [char]0x724C)
$gc = [regex]::Match($text, [regex]::Escape($visitTokenLabel) + "[\uFF1A:]\s*(\S+)")
if ($gc.Success) { $env:GITCODE_TOKEN = $gc.Groups[1].Value }

# ---- Tauri updater signing key (needed by scripts/release.mjs) ----
$keyPath = Join-Path $HOME '.tauri\shuyonote.key'
$pwPath = Join-Path $HOME '.tauri\shuyonote.key.pw'
if (Test-Path -LiteralPath $keyPath) {
  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -LiteralPath $keyPath -Raw).Trim()
}
if (Test-Path -LiteralPath $pwPath) {
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -LiteralPath $pwPath -Raw).Trim()
} else {
  $pw = [regex]::Match($text, '\(\.key\.pw\):\s*(\S+)')
  if ($pw.Success) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $pw.Groups[1].Value }
}

Write-Output "loaded from: $CredPath"
Show-Set 'GITCODE_TOKEN' $env:GITCODE_TOKEN 'gitcode'
$ghShape = if ($env:GH_TOKEN -like 'github_pat_*') { 'fine-grained' } elseif ($env:GH_TOKEN) { 'classic' } else { 'none' }
Show-Set 'GH_TOKEN' $env:GH_TOKEN $ghShape
Show-Set 'TAURI_SIGNING_PRIVATE_KEY' $env:TAURI_SIGNING_PRIVATE_KEY 'key file'
Show-Set 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD' $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD 'password'

$missing = @()
if ([string]::IsNullOrEmpty($env:GITCODE_TOKEN)) { $missing += 'GITCODE_TOKEN' }
if ([string]::IsNullOrEmpty($env:GH_TOKEN)) { $missing += 'GH_TOKEN' }
if ([string]::IsNullOrEmpty($env:TAURI_SIGNING_PRIVATE_KEY)) { $missing += 'TAURI_SIGNING_PRIVATE_KEY' }
if ([string]::IsNullOrEmpty($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) { $missing += 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD' }
if ($missing.Count -gt 0) {
  Write-Output ("MISSING: " + ($missing -join ', '))
  if ($Verify) { exit 1 }
}

if ($Verify) {
  $bad = @()
  if ($env:GH_TOKEN) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Headers @{ Authorization = "token $($env:GH_TOKEN)" } -Uri 'https://api.github.com/repos/ShuyoNote/ShuyoNote'
      Write-Output ("  github api: {0} OK" -f $r.StatusCode)
    } catch { $bad += 'GH_TOKEN'; Write-Output ("  github api: FAILED ({0})" -f $_.Exception.Message) }
  }
  if ($env:GITCODE_TOKEN) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Headers @{ Authorization = "token $($env:GITCODE_TOKEN)" } -Uri 'https://gitcode.com/api/v5/repos/shuyo-cn/ShuyoNote'
      Write-Output ("  gitcode api: {0} OK" -f $r.StatusCode)
    } catch { $bad += 'GITCODE_TOKEN'; Write-Output ("  gitcode api: FAILED ({0})" -f $_.Exception.Message) }
  }
  if ($bad.Count -gt 0) {
    Write-Output ("VERIFY FAILED: " + ($bad -join ', ') + " -- a release would stop on a 401/403 later")
    exit 1
  }
  Write-Output 'VERIFY OK'
}
exit 0
