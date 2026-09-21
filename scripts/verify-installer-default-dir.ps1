#Requires -Version 5
<#
  Read the NSIS wizard's PREFILLED install directory, then cancel. Never installs.

  Why this exists (2026-09-21):
    The owner looked at the installer's "choose install location" page and asked
    "the install path is not professional?" -- the path shown there was
    C:\Users\<user>\_archive\shuyonote-install-test, which is NOT the product default.
    Tauri's NSIS template calls `RestorePreviousInstallLocation`, which read
    HKCU\Software\<manufacturer>\<productName> (default value) and reused the directory
    of an earlier test install (that folder no longer exists). The template writes that
    value on every install: WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR.

    Two facts must be checked by measuring, not by reading code:
      1. what a FRESH machine gets (the template's own default), and
      2. that our forked template really changed it (see src-tauri/nsis/installer.nsi).

  How it works:
    - starts the given setup .exe and finds its wizard window by PID + class #32770,
    - clicks "next" on the welcome page only, until the directory page shows up
      (detected by the browse button),
    - reads the path EDIT control cross-process with WM_GETTEXT
      (GetWindowText returns an empty string for another process's EDIT),
    - prints the value, then clicks cancel / yes and exits. It NEVER clicks install.

  Usage (Windows):
    powershell -File scripts/verify-installer-default-dir.ps1 -Installer <setup.exe>
    powershell -File scripts/verify-installer-default-dir.ps1 -Installer <setup.exe> -Expect 'C:\Users'

  Exit codes: 0 = read a path (and it matched -Expect when given); 1 = failed to read;
              2 = environment not usable (installer missing, no wizard) -- never a silent pass.
  ASCII-ONLY on purpose: PS 5.1 parses no-BOM .ps1 in the OEM codepage (see check-ps1-ascii),
  so button labels are matched by Unicode codepoints, not by literal Chinese text.
#>
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$Expect = '',
  [int]$TimeoutSec = 40
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Installer)) {
  Write-Output "ENV: installer not found: $Installer"
  exit 2
}

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshNsis {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string Text(IntPtr h) { var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024); return sb.ToString(); }
  public static string CtlText(IntPtr h) { var sb = new StringBuilder(1024); SendMessageW(h, 0x000D, (IntPtr)1024, sb); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static List<IntPtr> Kids(IntPtr p) { var l = new List<IntPtr>(); EnumChildWindows(p, (h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static List<IntPtr> Tops() { var l = new List<IntPtr>(); EnumWindows((h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
}
'@

# Button labels by codepoint (avoid non-ASCII literals in this file):
#   next  = U+4E0B U+4E00 U+6B65   ("xia yi bu")
#   prev  = U+4E0A U+4E00 U+6B65
#   canc  = U+53D6 U+6D88          ("qu xiao")
#   yes   = U+662F                 ("shi")
#   browse= U+6D4F U+89C8          ("liu lan")
$BTN_NEXT = [string]([char]0x4E0B + [char]0x4E00 + [char]0x6B65)
$BTN_CANCEL = [string]([char]0x53D6 + [char]0x6D88)
$BTN_YES = [string][char]0x662F
$BTN_BROWSE = [string]([char]0x6D4F + [char]0x89C8)

$proc = Start-Process -FilePath $Installer -PassThru
$targetPid = [uint32]$proc.Id
$dlg = [IntPtr]::Zero
$found = ''
Write-Output "started installer pid=$targetPid"

try {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline -and $dlg -eq [IntPtr]::Zero) {
    foreach ($h in [DshNsis]::Tops()) {
      if ([DshNsis]::Pid($h) -ne $targetPid) { continue }
      if (-not [DshNsis]::IsWindowVisible($h)) { continue }
      if ([DshNsis]::Cls($h) -ne '#32770') { continue }
      $dlg = $h; break
    }
    if ($dlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 }
  }
  if ($dlg -eq [IntPtr]::Zero) {
    Write-Output "ENV: no installer wizard window (a UAC prompt or a silent/blocked start?)"
    exit 2
  }
  Write-Output ("wizard: class=#32770 title='" + [DshNsis]::Text($dlg) + "'")
  [void][DshNsis]::SetForegroundWindow($dlg)

  $found = ''
  for ($round = 1; $round -le 6; $round++) {
    Start-Sleep -Milliseconds 900
    $kids = [DshNsis]::Kids($dlg)

    $paths = @($kids | Where-Object {
        ([DshNsis]::Cls($_) -eq 'Edit' -or [DshNsis]::Cls($_) -eq 'ComboBox') -and
        [DshNsis]::IsWindowVisible($_) -and
        ([DshNsis]::CtlText($_) -match '^[A-Za-z]:\\')
      })
    if ($paths.Count -gt 0) { $found = [DshNsis]::CtlText($paths[0]); break }

    # the directory page is the one with a "browse" button; never click next once it is there
    $browse = @($kids | Where-Object { [DshNsis]::IsWindowVisible($_) -and ([DshNsis]::Text($_) -like "*$BTN_BROWSE*") })
    if ($browse.Count -gt 0) { continue }

    $next = @($kids | Where-Object {
        [DshNsis]::Cls($_) -eq 'Button' -and [DshNsis]::IsWindowVisible($_) -and
        [DshNsis]::IsWindowEnabled($_) -and ([DshNsis]::Text($_) -like "*$BTN_NEXT*")
      })
    if ($next.Count -eq 0) { break }
    [void][DshNsis]::SendMessage($next[0], 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
  }
  if ($found -eq '') { Write-Output 'FAIL: could not read the prefilled install directory'; exit 1 }
  Write-Output "DEFAULT_INSTALL_DIR=$found"
} finally {
  # always cancel; never run the install
  if ($dlg -ne [IntPtr]::Zero) {
    $kids = [DshNsis]::Kids($dlg)
    $cancel = @($kids | Where-Object { [DshNsis]::Cls($_) -eq 'Button' -and [DshNsis]::IsWindowVisible($_) -and ([DshNsis]::Text($_) -like "*$BTN_CANCEL*") })
    if ($cancel.Count -gt 0) { [void][DshNsis]::SendMessage($cancel[0], 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) }
    Start-Sleep -Milliseconds 900
    $kids = [DshNsis]::Kids($dlg)
    $yes = @($kids | Where-Object { [DshNsis]::Cls($_) -eq 'Button' -and [DshNsis]::IsWindowVisible($_) -and ([DshNsis]::Text($_) -like "$BTN_YES*") })
    if ($yes.Count -gt 0) { [void][DshNsis]::SendMessage($yes[0], 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) }
  }
  Start-Sleep -Milliseconds 700
  if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Output 'wizard killed (nothing installed)'
  } else {
    Write-Output 'wizard exited (nothing installed)'
  }
}

if ($Expect -ne '') {
  if ($found -eq $Expect) { Write-Output "PASS: default dir == expected"; exit 0 }
  Write-Output "FAIL: default dir '$found' != expected '$Expect'"
  exit 1
}
exit 0
