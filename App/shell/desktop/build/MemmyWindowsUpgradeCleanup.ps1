param(
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [string]$BackupRoot = ''
)

Start-Sleep -Seconds 3
Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
if ($BackupRoot) {
  $backupParent = Split-Path -Parent $BackupRoot
  if ((Split-Path -Leaf $backupParent).EndsWith('.memmy-upgrade-backup', [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $BackupRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupParent -Force -ErrorAction SilentlyContinue
  }
}
