param([Parameter(Mandatory = $true)][string]$Folder)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# Lists which processes hold any file under $Folder open, via the Restart Manager API.
$src = @"
using System;
using System.Runtime.InteropServices;
public static class RmProbe {
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint lo; public uint hi; }
  [StructLayout(LayoutKind.Sequential)] public struct RM_UNIQUE_PROCESS { public int dwProcessId; public FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint n, string[] files, uint a, RM_UNIQUE_PROCESS[] p, uint s, string[] svc);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint n, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  public static int[] Holders(string file) {
    uint h; if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return new int[0];
    try {
      RmRegisterResources(h, 1, new[] { file }, 0, null, 0, null);
      uint needed = 0, n = 0, reasons = 0;
      int r = RmGetList(h, out needed, ref n, null, ref reasons);
      if (needed == 0) return new int[0];
      var info = new RM_PROCESS_INFO[needed]; n = needed;
      RmGetList(h, out needed, ref n, info, ref reasons);
      var ids = new int[n]; for (int i = 0; i < n; i++) ids[i] = info[i].Process.dwProcessId; return ids;
    } finally { RmEndSession(h); }
  }
}
"@
Add-Type -TypeDefinition $src
$found = $false
Get-ChildItem -LiteralPath $Folder -File -Recurse | ForEach-Object {
  $ids = [RmProbe]::Holders($_.FullName)
  foreach ($id in $ids) {
    $found = $true
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    $type = if ($p.CommandLine -match '--type=([\w-]+)') { $Matches[1] } else { 'main' }
    $util = if ($p.CommandLine -match '--utility-sub-type=([\w.]+)') { $Matches[1] } else { '' }
    "{0}`t{1}`t{2}`t{3} {4}" -f $_.Name, $id, $p.Name, $type, $util
  }
}
if (-not $found) { "no holders" }
