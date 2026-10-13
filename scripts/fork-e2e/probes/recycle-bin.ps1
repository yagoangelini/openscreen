param([Parameter(Mandatory = $true)][string]$DeletedFrom)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# The names of the Recycle Bin items that were deleted from $DeletedFrom, one per line.
$bin = (New-Object -ComObject Shell.Application).NameSpace(10)
$target = [System.IO.Path]::GetFullPath($DeletedFrom).TrimEnd('\').ToLowerInvariant()
foreach ($item in $bin.Items()) {
  $from = [string]$item.ExtendedProperty("System.Recycle.DeletedFrom")
  if ($from.TrimEnd('\').ToLowerInvariant() -eq $target) { $item.Name }
}
