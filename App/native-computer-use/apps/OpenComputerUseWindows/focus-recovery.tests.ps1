param([string]$RuntimePath = (Join-Path $PSScriptRoot 'runtime.ps1'))

# Import production functions, replacing only OS/timing boundaries. No real
# desktop, input injection, activation, or UI Automation is used by this suite.
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($RuntimePath)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | ForEach-Object Message) }
$native = [regex]::Match($source, '(?s)Add-Type -TypeDefinition @"\r?\n(.*?)\r?\n"@')
Add-Type -TypeDefinition $native.Groups[1].Value
$definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))
foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }
$productionRead = (Get-Item Function:\Read-ForegroundClickState).ScriptBlock
$results = New-Object 'Collections.Generic.List[object]'
function Assert($value, [string]$message) { if (-not $value) { throw $message } }
function Case([string]$name, [scriptblock]$body) {
    try { & $body; $results.Add([pscustomobject]@{ name = $name; passed = $true }) }
    catch { $results.Add([pscustomobject]@{ name = $name; passed = $false; error = $_.Exception.Message }) }
}
function Focus([long]$hwnd, [int]$owner, [uint32]$tick = 100) {
    [pscustomobject]@{ hwnd = [IntPtr]$hwnd; processId = $owner; inputTick = $tick; idleMilliseconds = 10000 }
}
function Reset {
    $script:operation = [pscustomobject]@{ tool = 'click'; foreground = $false; related_window_ids = @(); deadline_epoch_ms = [long]::MaxValue }
    $script:focusBefore = Focus 700 900
    $script:focusGuardYield = $false; $script:focusChangedByApp = $false; $script:dispatched = $true
    $script:foregroundRestoreAttempted = $false
    $script:states = @((Focus 101 500)); $script:reads = 0
    $script:restorable = @($true, $true); $script:restoreChecks = 0
    $script:activationAccepted = $true; $script:activations = 0; $script:waits = 0
}
function Read-ForegroundClickState {
    $index = [Math]::Min($script:reads, $script:states.Count - 1); $script:reads++
    return $script:states[$index]
}
function Test-ForegroundRestoreTarget([IntPtr]$hwnd, [int]$processId) {
    Assert ($hwnd -eq [IntPtr]700 -and $processId -eq 900) 'Undo lost the exact previous HWND/PID'
    $index = [Math]::Min($script:restoreChecks, $script:restorable.Count - 1); $script:restoreChecks++
    return $script:restorable[$index]
}
function Restore-PreviousForeground([IntPtr]$hwnd) {
    Assert ($hwnd -eq [IntPtr]700) 'Undo retargeted another window'
    $script:activations++; return $script:activationAccepted
}
function Wait-ForegroundRestoreStep { $script:waits++ }

Case 'A zero foreground permits observation but does not permit ordinary background dispatch' {
    Reset; $script:states = @((Focus 0 0))
    $focus = Read-FocusState -AllowUnknown
    Assert ($focus.hwnd -eq [IntPtr]::Zero -and $focus.inputTick -eq 100) 'Unknown focus lost input metadata'
    $blocked = $false; try { [void](Read-ActionFocus) } catch { $blocked = $true }
    Assert $blocked 'Background action was allowed without verified foreground state'
}
Case 'Only the three explicit foreground input tools may start with unknown foreground' {
    foreach ($tool in @('click', 'type_text', 'press_key', 'set_value', 'scroll', 'drag', 'perform_secondary_action')) {
        Reset; $script:states = @((Focus 0 0)); $script:operation.tool = $tool; $script:operation.foreground = $true
        $allowed = $true; try { [void](Read-ActionFocus) } catch { $allowed = $false }
        Assert ($allowed -eq @('click', 'type_text', 'press_key').Contains($tool)) "Unexpected recovery permission for $tool"
    }
}
Case 'An unavailable input desktop blocks both observation and explicit foreground recovery before native reads' {
    function Test-InteractiveDesktop { $false }
    function Read-ForegroundClickState { & $productionRead }
    foreach ($mode in @('observe', 'foreground')) {
        Reset; $script:operation.tool = 'press_key'; $script:operation.foreground = $true
        $errorText = ''
        try { if ($mode -eq 'observe') { [void](Read-FocusState -AllowUnknown) } else { [void](Read-ActionFocus) } }
        catch { $errorText = $_.Exception.Message }
        Assert ($errorText.Contains('unlocked input desktop')) "Unavailable desktop did not stop $mode"
    }
}
Case 'Snapshot refuses an unavailable desktop before resolving or capturing an application' {
    function Test-InteractiveDesktop { $false }
    function Read-ForegroundClickState { & $productionRead }
    $script:appResolved = $false
    function Resolve-App { $script:appResolved = $true; throw 'Unexpected app lookup' }
    $errorText = ''; try { Build-Snapshot 'PowerPoint' } catch { $errorText = $_.Exception.Message }
    Assert ($errorText.Contains('unlocked input desktop') -and -not $script:appResolved) 'Locked snapshot reached application observation'
}
Case 'Losing foreground after an action preserves its uncertain result without throwing away observation' {
    Reset; $script:states = @((Focus 0 0))
    Assert-SafeAfterAction $script:focusBefore 500 ([IntPtr]101)
    Assert ($script:focusChangedByApp -and $script:dispatched -and $script:activations -eq 0) 'Empty foreground was reported as a confirmed action or activated a window'
}
Case 'An Office-style non-restorable editor is never reactivated after its menu opens' {
    Reset; $script:restorable = @($false)
    Assert-SafeAfterAction $script:focusBefore 500 ([IntPtr]101)
    Assert ($script:focusChangedByApp -and $script:activations -eq 0) 'Floating editor was reactivated'
}
Case 'A successful activation return cannot confirm an actual zero foreground' {
    Reset; $script:states = @((Focus 101 500), (Focus 101 500), (Focus 0 0))
    Assert-SafeAfterAction $script:focusBefore 500 ([IntPtr]101)
    Assert ($script:focusChangedByApp -and $script:activations -eq 1 -and $script:waits -le 3) 'Unverified restoration was confirmed or replayed'
}
Case 'Foreground hand-back requires two stable readings of the exact previous HWND and PID' {
    Reset; $script:states = @((Focus 101 500), (Focus 101 500), (Focus 700 900), (Focus 700 900))
    Assert-SafeAfterAction $script:focusBefore 500 ([IntPtr]101)
    Assert (-not $script:focusChangedByApp -and $script:activations -eq 1 -and $script:waits -eq 1) 'Actual restoration was not confirmed exactly once'
}
Case 'A previous HWND whose owner changes before dispatch is never activated' {
    Reset; $script:states = @((Focus 101 500)); $script:restorable = @($true, $false)
    Assert-SafeAfterAction $script:focusBefore 500 ([IntPtr]101)
    Assert ($script:activations -eq 0 -and $script:focusChangedByApp) 'PID-reused foreground was restored'
}
Case 'User input while restoration is being verified cancels confirmation without another activation' {
    Reset; $script:states = @((Focus 101 500), (Focus 101 500), (Focus 700 900 101))
    Assert-SafeAfterAction $script:focusBefore 500 ([IntPtr]101)
    Assert ($script:activations -eq 1 -and $script:focusChangedByApp) 'User input was ignored or restoration was replayed'
}
Case 'A declined restoration remains unconfirmed and is not retried' {
    Reset; $script:activationAccepted = $false
    Assert-SafeAfterAction $script:focusBefore 500 ([IntPtr]101)
    Assert ($script:activations -eq 1 -and $script:focusChangedByApp) 'Declined restoration was confirmed or retried'
}

Case 'The final cleanup cannot retry an unconfirmed hand-back for the same action' {
    Reset; $script:activationAccepted = $false
    Assert-SafeAfterAction $script:focusBefore 500 ([IntPtr]101)
    Assert-SafeAfterAction $script:focusBefore 500 ([IntPtr]101)
    Assert ($script:activations -eq 1 -and $script:focusChangedByApp) 'Finally retried an unconfirmed activation'
}

$failed = @($results | Where-Object { -not $_.passed })
[pscustomobject]@{ passed = $results.Count - $failed.Count; failed = $failed.Count; tests = $results.ToArray() } | ConvertTo-Json -Depth 6
if ($failed.Count) { exit 1 }
