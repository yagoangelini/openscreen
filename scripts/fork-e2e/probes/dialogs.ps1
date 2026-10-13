param([Parameter(Mandatory = $true)][string]$Profile, [switch]$Close)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# Lists visible dialog windows (#32770, the class of shell file-operation prompts) owned by
# the isolated instance's processes (Name electron.exe AND a command line with $Profile).
# With -Close, sends each one WM_CLOSE (a window message to our own process, not OS input).
$src = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DlgProbe {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<string> Find(int[] pids, bool close) {
    var hits = new List<string>();
    var set = new HashSet<uint>(); foreach (var p in pids) set.Add((uint)p);
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!set.Contains(pid) || !IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() != "#32770") return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      hits.Add(pid + "\t" + t.ToString());
      if (close) PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return hits;
  }
}
"@
Add-Type -TypeDefinition $src
$pids = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like "*$Profile*" } | ForEach-Object { [int]$_.ProcessId })
$hits = [DlgProbe]::Find($pids, [bool]$Close)
if ($hits.Count -eq 0) { "no dialogs" } else { $hits }
