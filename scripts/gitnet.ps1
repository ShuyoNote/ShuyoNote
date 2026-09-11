# gitnet -- a git wrapper that always disables the proxy (2026-09-11)
#
# Why: this machine has a proxy at 127.0.0.1:7897 which is often dead. Forget the
# `-c http.proxy= -c https.proxy=` flags once and git network commands die:
#   fatal: unable to access '...': Failed to connect to 127.0.0.1 port 7897
# That rule was written into the workflow three times today and forgotten three
# times, so it should not live in anyone's memory -- it lives here.
#
# NOTE: deliberately ASCII only. PowerShell 5.1 reads UTF-8 without BOM as ANSI,
# so non-ASCII text in a .ps1 becomes mojibake and the script fails to parse.
#
# Usage:  .\scripts\gitnet.ps1 status
#         .\scripts\gitnet.ps1 fetch | pull
#         .\scripts\gitnet.ps1 push <branch>       (or push <src>:<dst>)
#         .\scripts\gitnet.ps1 log [n]
#         .\scripts\gitnet.ps1 raw <git args...>
# Force pushing is not supported; this script never passes --force.

param(
    [Parameter(Position = 0)][string]$Command = "status",
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = "Stop"
$NoProxy = @("-c", "http.proxy=", "-c", "https.proxy=")

function Invoke-Git {
    param([string[]]$GitArgs, [switch]$Quiet)
    if ($Quiet) { & git @NoProxy @GitArgs 2>&1 | Out-Null } else { & git @NoProxy @GitArgs }
    return $LASTEXITCODE
}

function Show-Status {
    Invoke-Git @("fetch", "origin", "--quiet") -Quiet | Out-Null
    Write-Output "== repo =="
    Write-Output ("  path   : " + (Get-Location))
    Write-Output ("  branch : " + (& git rev-parse --abbrev-ref HEAD))
    Write-Output ""
    Write-Output "== branch comparison =="
    $all = @(& git for-each-ref --format='%(refname:short)' refs/heads)
    foreach ($b in $all) {
        $remote = "origin/$b"
        if (-not (& git rev-parse --verify --quiet $remote)) { continue }
        $ahead = [int](& git rev-list --count "$remote..$b")
        $behind = [int](& git rev-list --count "$b..$remote")
        $state = "in sync (ok)"
        if ($ahead -gt 0 -and $behind -eq 0) { $state = "local ahead by $ahead -> needs push" }
        elseif ($behind -gt 0 -and $ahead -eq 0) { $state = "remote ahead by $behind -> needs pull" }
        elseif ($ahead -gt 0 -and $behind -gt 0) { $state = "diverged a=$ahead b=$behind -> needs a human" }
        Write-Output ("  {0,-8} {1,-10} {2}" -f $b, (& git rev-parse --short $b), $state)
    }
    Write-Output ""
    $st = & git status --porcelain
    if ($st) {
        Write-Output ("== uncommitted (" + (@($st) | Measure-Object).Count + ") ==")
        $st | Select-Object -First 10 | ForEach-Object { Write-Output ("  " + $_) }
    } else {
        Write-Output "working tree clean (ok)"
    }
}

switch ($Command.ToLower()) {
    "status" { Show-Status }
    "fetch" { Invoke-Git @("fetch", "origin", "--prune") | Out-Null; Write-Output "fetch done (ok)" }
    "pull" {
        $cur = & git rev-parse --abbrev-ref HEAD
        Invoke-Git @("pull", "--ff-only", "origin", $cur) | Out-Null
        Write-Output "pull done, fast-forward only (ok)"
    }
    "push" {
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Output "ERROR: name the branch explicitly -- push <branch> or push <src>:<dst>"
            Write-Output "  (no default on purpose: a default caused a wrong-branch commit today.)"
            exit 2
        }
        $spec = $Rest[0]
        if ($spec -match '--force') { Write-Output "ERROR: no force push"; exit 2 }
        Write-Output ("  pushing $spec (HEAD=" + (& git rev-parse --short HEAD) + ")")
        $code = Invoke-Git @("push", "origin", $spec)
        if ($code -ne 0) {
            Write-Output "ERROR: push failed. If rejected, fetch first then rebase/merge."
            Write-Output "       Do not force push."
            exit $code
        }
        Invoke-Git @("fetch", "origin", "--quiet") -Quiet | Out-Null
        Write-Output "  after push:"
        Write-Output ("    local HEAD = " + (& git rev-parse --short HEAD))
        if ($spec -match ':') {
            $dst = $spec.Split(':')[1]
            Write-Output ("    origin/" + $dst + " = " + (& git rev-parse --short "origin/$dst"))
        } else {
            Write-Output ("    origin/" + $spec + " = " + (& git rev-parse --short "origin/$spec"))
        }
    }
    "log" {
        $n = "8"
        if ($Rest -and $Rest.Count -gt 0) { $n = $Rest[0] }
        Invoke-Git @("log", "--oneline", "-n", $n) | Out-Null
    }
    "raw" {
        if (-not $Rest) { Write-Output "usage: raw <git args...>"; exit 2 }
        Invoke-Git $Rest | Out-Null
    }
    default {
        Write-Output ("unknown command: " + $Command)
        Write-Output "available: status | fetch | pull | push <branch> | log [n] | raw <args...>"
        exit 2
    }
}
