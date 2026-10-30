<# Record native CTest execution separately from unavailable desktop cases. #>
[CmdletBinding()]
param([Parameter(Mandatory)] [string] $Report, [Parameter(Mandatory)] [string] $Output)
$ErrorActionPreference = 'Stop'
[xml] $results = Get-Content -LiteralPath $Report -Raw
$cases = @($results.SelectNodes('//testcase'))
$skipped = @($cases | Where-Object { $_.SelectSingleNode('skipped') })
$failed = @($cases | Where-Object { $_.SelectSingleNode('failure') -or $_.SelectSingleNode('error') })
$passed = @($cases | Where-Object { -not $_.SelectSingleNode('skipped') -and -not $_.SelectSingleNode('failure') -and -not $_.SelectSingleNode('error') })
$summary = [ordered]@{ total = $cases.Count; passed = $passed.Count; failed = $failed.Count; skipped = $skipped.Count;
  skippedTests = @($skipped | ForEach-Object { $_.name }); userInteractive = [Environment]::UserInteractive;
  sessionId = (Get-Process -Id $PID).SessionId; installedApp = $false }
$summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Output -Encoding utf8
$line = "Native History: $($summary.passed) passed, $($summary.failed) failed, $($summary.skipped) skipped (total $($summary.total))."
Write-Host $line
if ($env:GITHUB_STEP_SUMMARY) { $line | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY }
foreach ($name in @('unit', 'win.boundaries', 'win.metadata', 'integration.cli_contract', 'task_video.media_integrity')) {
  if ($name -notin @($passed | ForEach-Object { $_.name })) { throw "Required native case did not pass: $name" }
}
if ($failed.Count -or -not $cases.Count) { throw 'Native History validation failed.' }
