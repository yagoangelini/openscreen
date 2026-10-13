param(
  [Parameter(Mandatory = $true)][string]$File,
  [double]$Seconds = 3,
  [string]$Share = "ReadWrite, Delete"
)
# Holds $File open for $Seconds, the way another program would (Explorer's preview, a
# player, an antivirus). "ReadWrite, Delete" sharing is the kind that made shell.trashItem
# show its "Folder Access Denied" prompt before the library waited for the take to be free.
$handle = [System.IO.File]::Open($File, 'Open', 'Read', $Share)
"holding"
Start-Sleep -Milliseconds ([int]($Seconds * 1000))
$handle.Close()
"released"
