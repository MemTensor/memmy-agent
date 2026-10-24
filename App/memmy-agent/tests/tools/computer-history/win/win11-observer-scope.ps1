param([string]$ObserverPath = (Join-Path $PSScriptRoot '../../../../src/tools/computer-history/win/win11-observer.ps1'))

# Runs on Windows PowerShell 5.1 or PowerShell 7 without loading UIA, opening a
# window, or sampling user activity. Keep the production param block and entire
# supervisor body: extracting only a function would hide script-scope constraints.
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$observerAst = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $ObserverPath).Path, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw $parseErrors[0] }
if ($null -eq $observerAst.ParamBlock) { throw 'Observer param block is missing' }
$source = Get-Content -LiteralPath $ObserverPath -Raw
$supervisorStart = $source.IndexOf('$lastWindow =')
if ($supervisorStart -lt 0) { throw 'Observer supervisor body is missing' }
$supervisorBody = $source.Substring($supervisorStart)
$requiredFunctions = @('SanitizeUrl', 'NormalizeWorkerSample', 'RecorderDiagnostic', 'UpdateObserverHealth')
$functionBodies = @()
foreach ($name in $requiredFunctions) {
  $definition = @($observerAst.EndBlock.Statements | Where-Object {
    $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq $name
  })
  if ($definition.Count -ne 1) { throw "Observer function $name is missing or duplicated" }
  $functionBodies += $definition[0].Extent.Text
}

function EventFixture([string]$text) {
  return @{ ok = $true; skipped = $false; observed = $true; readFailures = 0;
    foregroundWindow = '123'; foregroundProcessId = 100;
    event = @{ timestamp = '2026-10-10T00:00:00.0000000Z';
      app = @{ name = 'scope-fixture'; bundleIdentifier = 'win32.scope-fixture' };
      window = @{ title = 'scope fixture'; browser = $false };
      ax = @{ mode = 'fullTree'; windowKey = 'scope-fixture'; text = $text } } }
}

$scopeSamples = New-Object System.Collections.Queue
foreach ($fixtureCase in @(
  (EventFixture 'first'),
  (EventFixture 'first'),
  (EventFixture 'changed'),
  (EventFixture 'stale'),
  @{ ok = $true; skipped = $true; privacyUnknown = $true; readFailures = 0 },
  @{ ok = 'true' },
  @{ ok = $false },
  (EventFixture 'recovered')
)) { $scopeSamples.Enqueue($fixtureCase) }
$foregroundVerdicts = New-Object System.Collections.Queue
foreach ($verdict in @($true, $true, $true, $false, $true)) { $foregroundVerdicts.Enqueue($verdict) }
$emittedLines = New-Object 'System.Collections.Generic.List[string]'
$executedSamples = New-Object 'System.Collections.Generic.List[object]'
$bindingChecks = New-Object 'System.Collections.Generic.List[object]'

# The only replaced boundaries are the native worker/foreground APIs and sleep.
# Samples still pass through the production JSON envelope normalizer, health
# updates, deduplication, foreground check and event serialization.
$testBoundaries = @'
$ErrorActionPreference = 'Stop'
$diagnosticLastAt = @{}
$diagnosticCounts = @{}
function InvokeHistorySample {
  if ($scopeSamples.Count -eq 0) { throw 'MemmyScopeHarnessFinished' }
  $executedSamples.Add($true)
  return NormalizeWorkerSample ($scopeSamples.Dequeue())
}
function SampleStillForeground([object]$sample) {
  if ($foregroundVerdicts.Count -eq 0) { throw 'Unexpected foreground check' }
  return $foregroundVerdicts.Dequeue()
}
function Start-Sleep { param([int]$Milliseconds) }
try {
'@
$testCompletion = @'
} catch {
  if ($_.Exception.Message -ne 'MemmyScopeHarnessFinished') { throw }
}
$bindingChecks.Add(@{ type = $Sample.GetType().FullName; present = $Sample.IsPresent })
'@
$harnessScript = [scriptblock]::Create($observerAst.ParamBlock.Extent.Text + "`n" +
  ($functionBodies -join "`n") + "`n" + $testBoundaries + "`n" + $supervisorBody + "`n" + $testCompletion)
& $harnessScript | ForEach-Object { $emittedLines.Add([string]$_) }

if ($executedSamples.Count -ne 8 -or $foregroundVerdicts.Count -ne 0) { throw 'Supervisor did not consume every fixture' }
if ($bindingChecks.Count -ne 1 -or $bindingChecks[0].type -ne 'System.Management.Automation.SwitchParameter' -or
  $bindingChecks[0].present) { throw 'Supervisor overwrote the Sample switch' }
$signals = @($emittedLines | ForEach-Object { $_ | ConvertFrom-Json })
$events = @($signals | Where-Object { $_.kind })
if ($events.Count -ne 3 -or $events[0].kind -ne 'window.changed' -or
  $events[1].kind -ne 'accessibility.changed' -or $events[2].kind -ne 'window.changed') {
  throw 'Supervisor event deduplication or reset failed'
}
if ($events[0].ax.text -ne 'first' -or $events[1].ax.text -ne 'changed' -or
  $events[2].ax.text -ne 'recovered') { throw 'Supervisor emitted incorrect fixture content' }
$diagnostics = @($signals | Where-Object { $_.type -eq 'recorder.diagnostic' })
foreach ($code in @('heartbeat', 'observer_ready', 'privacy_unknown', 'observer_unavailable')) {
  if (@($diagnostics | Where-Object { $_.code -eq $code }).Count -lt 1) { throw "Missing $code diagnostic" }
}

# Check every script parameter against script-scope assignments, ignoring
# separate function scopes where an explicitly local parameter/data variable is
# independent. Run this after the real supervisor so a regression first fails
# with the same Hashtable -> SwitchParameter conversion as the shipped script.
$parameterNames = @($observerAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
$assignments = $observerAst.FindAll({ param($node)
  ($node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [System.Management.Automation.Language.VariableExpressionAst]) -or
  $node -is [System.Management.Automation.Language.ForEachStatementAst]
}, $true)
foreach ($assignment in $assignments) {
  $parent = $assignment.Parent
  $inFunction = $false
  while ($null -ne $parent) {
    if ($parent -is [System.Management.Automation.Language.FunctionDefinitionAst]) { $inFunction = $true; break }
    $parent = $parent.Parent
  }
  $target = if ($assignment -is [System.Management.Automation.Language.ForEachStatementAst]) { $assignment.Variable } else { $assignment.Left }
  if (-not $inFunction -and $parameterNames -icontains $target.VariablePath.UserPath) {
    throw "Script parameter reused for data: $($target.Extent.Text)"
  }
}

ConvertTo-Json -InputObject @{ runtime = $PSVersionTable.PSVersion.ToString(); realSupervisor = $true;
  sampleSwitchPreserved = $true; fixtures = $executedSamples.Count; events = $events.Count;
  staleForegroundSuppressed = $true; duplicateSuppressed = $true; observerRecovery = $true } -Compress
