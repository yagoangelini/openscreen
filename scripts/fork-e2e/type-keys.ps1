# Types a few chords and plain letters into a window of its own, for the keystroke-plate
# smoke test. Refuses to send anything unless its own window is in the foreground, so a key
# can never land in another application.
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Fg {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@

$form = New-Object System.Windows.Forms.Form
$form.Text = "OpenScreen e2e keys"
$form.TopMost = $true
$form.Width = 420
$form.Height = 160
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = "Fill"
$form.Controls.Add($box)
$form.Show()
$form.Activate()
[Fg]::SetForegroundWindow($form.Handle) | Out-Null
for ($i = 0; $i -lt 10; $i++) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 100
}

function Send-IfMine([string]$keys) {
    [System.Windows.Forms.Application]::DoEvents()
    if ([Fg]::GetForegroundWindow() -ne $form.Handle) {
        Write-Output "NOT-FOREGROUND before '$keys': nothing sent"
        $form.Close()
        exit 2
    }
    [System.Windows.Forms.SendKeys]::SendWait($keys)
    Start-Sleep -Milliseconds 350
}

Send-IfMine "^k"
Send-IfMine "abc"
Send-IfMine "^+p"
Send-IfMine "xyz"
[System.Windows.Forms.Application]::DoEvents()
Write-Output ("TYPED:" + $box.Text)
$form.Close()
exit 0
