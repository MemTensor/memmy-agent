param([string]$RuntimePath = (Join-Path $PSScriptRoot "runtime.ps1"))

# Run with pwsh on macOS/Linux or PowerShell on Windows. Parse the production
# script and import function declarations only; never execute its entry point,
# load UIAutomationClient, or call a User32/Kernel32 function in these tests.
$ErrorActionPreference = "Stop"
$source = [IO.File]::ReadAllText($RuntimePath)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw (($parseErrors | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }) -join "`n") }
$native = [regex]::Match($source, '(?s)Add-Type -TypeDefinition @"\r?\n(.*?)\r?\n"@')
if (-not $native.Success) { throw "Embedded C# definition not found" }
Add-Type -TypeDefinition $native.Groups[1].Value
$definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))
foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }
$productionReceiverGuard = (Get-Item Function:\Assert-ReceiverBelongsToTarget).ScriptBlock

function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
$results = New-Object 'Collections.Generic.List[object]'
function Case([string]$name, [scriptblock]$test) {
    try { & $test; $results.Add([pscustomobject]@{ name = $name; passed = $true }) }
    catch { $results.Add([pscustomobject]@{ name = $name; passed = $false; error = $_.Exception.Message }) }
}
function Reset-TestState {
    $script:focusGuardYield = $false
    $script:dispatched = $false
    $script:focusBefore = $null
    $script:targetProcessId = 500
    $script:targetWindow = [IntPtr]101
    $script:posted = New-Object 'Collections.Generic.List[object]'
    $script:gateCount = 0
    $script:yieldAt = 0
    $script:failPostAt = 0
    $script:expireAfterPost = 0
    $script:expiryLag = 1L
    $script:testEpochMilliseconds = 2000000L
    $script:pendingReleases = @{}
    $script:targetElementValidated = $false
    $script:operation = [pscustomobject]@{ deadline_epoch_ms = [long]::MaxValue
        observed_keyboard_receiver_id = 202L; observed_keyboard_receiver_runtime_id = @(42, 202)
        observed_keyboard_receiver_state = '{"selection":[3,3]}' }
    $script:keyboardReads = 0
    $script:keyboardChangeAt = 0
    $script:keyboardState = $script:operation.observed_keyboard_receiver_state
    $script:pointCaptureGroup = $null
    $script:pointReceiverRoot = [IntPtr]::Zero
}

# Replace only native/environment boundaries. Dispatch bookkeeping and the
# production click/key/UIA coordinators above remain the code under test.
function Assert-DispatchSafe([IntPtr]$receiver) {
    Assert-OperationDeadline
    $script:gateCount++
    if ($script:yieldAt -eq $script:gateCount) { Yield-UserInput "simulated user intervention" }
}
function Assert-TargetWindow([IntPtr]$hwnd, [int]$processId) {}
function Assert-ReceiverBelongsToTarget([IntPtr]$receiver, [switch]$CleanupOnly) {}
function Get-EpochMilliseconds { $script:testEpochMilliseconds }
function Send-NativeWindowMessage([IntPtr]$hwnd, [UInt32]$message, [IntPtr]$wParam, [IntPtr]$lParam) {
    $script:posted.Add([pscustomobject]@{ hwnd = $hwnd; message = $message; wParam = $wParam; lParam = $lParam })
    if ($script:expireAfterPost -eq $script:posted.Count) { $script:operation.deadline_epoch_ms = $script:testEpochMilliseconds - $script:expiryLag }
    [pscustomobject]@{ sent = ($script:failPostAt -ne $script:posted.Count); errorCode = 1460 }
}
function Resolve-PointReceiver([IntPtr]$root, [int]$screenX, [int]$screenY) {
    [pscustomobject]@{ hwnd = [IntPtr]202; x = 10; y = 20 }
}
function Read-KeyboardObservation([IntPtr]$root, [int]$processId, $rootElement) {
    $script:keyboardReads++
    $id = if ($script:keyboardChangeAt -gt 0 -and $script:keyboardReads -ge $script:keyboardChangeAt) { 303L } else { 202L }
    [pscustomobject]@{ receiverID = $id; runtimeID = @(42, [int]$id); state = $script:keyboardState; element = $null }
}
function Get-KeyMessageWords([IntPtr]$receiver, [uint32]$vk) {
    [pscustomobject]@{ down = [OCUWin32]::KeyLParam(0x4b, $true, $false)
        up = [OCUWin32]::KeyLParam(0x4b, $true, $true) }
}
$WM_MOUSEMOVE = 0x0200
$WM_KEYDOWN = 0x0100
$WM_KEYUP = 0x0101

Case "Embedded C# compiles without invoking Win32" {
    Assert ($null -ne ("OCUWin32" -as [type])) "C# native declarations did not compile"
}
Case "Packaged process identity imports the exact unsuffixed Kernel32 export" {
    $flags = [Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static
    $method = [OCUWin32].GetMethod('GetApplicationUserModelId', $flags)
    $attribute = @($method.GetCustomAttributes([Runtime.InteropServices.DllImportAttribute], $false))[0]
    Assert ($attribute.ExactSpelling -and $attribute.EntryPoint -eq 'GetApplicationUserModelId') "Packaged identity lookup probes a nonexistent Unicode-suffixed export"
}
Case "Coordinate words preserve negative multi-monitor positions and reject overflow" {
    $value = [OCUWin32]::PointLParam(-123, -456).ToInt64()
    Assert (($value -band 0xffff) -eq 65413) "Signed x was not encoded correctly"
    Assert ((($value -shr 16) -band 0xffff) -eq 65080) "Signed y was not encoded correctly"
    $rejected = $false
    try { [void][OCUWin32]::PointLParam(32768, 0) } catch { $rejected = $true }
    Assert $rejected "Unrepresentable coordinates silently wrapped"
}
Case "Wheel and key-up words follow the Win32 message layouts" {
    Assert ((([OCUWin32]::WheelWParam(-120).ToInt64() -shr 16) -band 0xffff) -eq 65416) "Wheel sign/delta is wrong"
    $down = [OCUWin32]::KeyLParam(0x4B, $true, $false).ToInt64() -band 0xffffffffL
    $up = [OCUWin32]::KeyLParam(0x4B, $true, $true).ToInt64() -band 0xffffffffL
    Assert ($down -eq 0x014B0001L) "Key-down scan/extended/repeat flags are wrong"
    Assert ($up -eq 0xC14B0001L) "Key-up transition/previous flags are wrong"
}
Case "Idle input handles tick wrap and non-monotonic future timestamps conservatively" {
    Assert ([OCUWin32]::InputIdleMilliseconds(20, [uint32]::MaxValue - 9) -eq 30) "32-bit tick wrap was not preserved"
    Assert ([OCUWin32]::InputIdleMilliseconds(100, 101) -eq 0) "Future input timestamp looked idle"
}
Case "Recent input yields only for the exact target HWND and PID" {
    Reset-TestState
    $a = [pscustomobject]@{ hwnd = [IntPtr]101; processId = 500; inputTick = 100; idleMilliseconds = 10 }
    $b = [pscustomobject]@{ hwnd = [IntPtr]102; processId = 500; inputTick = 100; idleMilliseconds = 10 }
    Assert-SafeBeforeAction $b 500 ([IntPtr]101)
    Assert (-not $script:focusGuardYield) "Another document in the same app blocked the target"
    $yielded = $false
    try { Assert-SafeBeforeAction $a 500 ([IntPtr]101) } catch { $yielded = $true }
    Assert ($yielded -and $script:focusGuardYield -and -not $script:dispatched) "Before-dispatch yield bookkeeping is incorrect"
}
Case "Before-dispatch intervention sends zero messages" {
    Reset-TestState; $script:yieldAt = 1
    try { Post-WindowMessage ([IntPtr]202) 0x0201 ([IntPtr]1) ([IntPtr]0) } catch {}
    Assert ($script:posted.Count -eq 0 -and -not $script:dispatched -and $script:focusGuardYield) "A rejected dispatch still posted input"
}
Case "An expired operation sends zero window messages or UIA actions" {
    Reset-TestState; $script:operation.deadline_epoch_ms = 1L
    $script:providerCalls = 0
    try { Post-WindowMessage ([IntPtr]202) 0x0201 ([IntPtr]1) ([IntPtr]0) } catch {}
    try { Invoke-UIAMutation { $script:providerCalls++ } } catch {}
    Assert ($script:posted.Count -eq 0 -and $script:providerCalls -eq 0 -and -not $script:dispatched) "Expired operation still dispatched"
}
Case "Expiry after button-down permits only its paired cleanup within 500ms without replay" {
    Reset-TestState; $script:expireAfterPost = 2
    $failed = $false
    try { Send-MouseClick ([IntPtr]101) 100 200 "left" 2 } catch { $failed = $true }
    Assert ($failed -and $script:dispatched -and $script:posted.Count -eq 3 -and $script:posted[2].message -eq 0x0202) "An expired partial operation did not end with only its paired cleanup"
    Assert (@($script:posted | Where-Object { $_.message -eq 0x0201 }).Count -eq 1) "Expired click replayed its original press"
    Assert (@($script:posted | Where-Object { $_.message -eq 0x0203 }).Count -eq 0) "Cleanup grace permitted a second press"
    Assert ($script:pendingReleases.Count -eq 0) "Completed cleanup retained a pending press"
}
Case "Expired cleanup rejects new presses, unmatched receivers and releases beyond its grace" {
    Reset-TestState
    Post-WindowMessage ([IntPtr]202) 0x0201 ([IntPtr]1) ([IntPtr]0)
    $script:operation.deadline_epoch_ms = $script:testEpochMilliseconds - 1
    foreach ($attempt in @(
        [pscustomobject]@{ hwnd = 202; message = 0x0201 },
        [pscustomobject]@{ hwnd = 202; message = 0x0200 },
        [pscustomobject]@{ hwnd = 303; message = 0x0202 })) {
        try { Post-WindowMessage ([IntPtr]$attempt.hwnd) $attempt.message ([IntPtr]0) ([IntPtr]0) -ReleaseOnly } catch {}
    }
    $script:operation.deadline_epoch_ms = $script:testEpochMilliseconds - 501
    try { Post-WindowMessage ([IntPtr]202) 0x0202 ([IntPtr]0) ([IntPtr]0) -ReleaseOnly } catch {}
    Assert ($script:posted.Count -eq 1) "The cleanup exception sent a new action, changed receiver or exceeded 500ms"
}
Case "Observed keyboard receiver changes reject input before any dispatch" {
    Reset-TestState; $script:keyboardChangeAt = 1
    $failed = $false
    try { Send-Key ([IntPtr]101) "left" } catch { $failed = $true }
    Assert ($failed -and $script:posted.Count -eq 0 -and -not $script:dispatched) "A background focus change sent the key to another field"
}
Case "The same receiver keeps receiving keys after its caret or text changes" {
    Reset-TestState; $script:keyboardState = '{"selection":[7,7],"valueDigest":"text typed since observation"}'
    Send-Key ([IntPtr]101) "left"
    Assert ($script:dispatched -and $script:posted.Count -eq 2) "A caret or text change blocked the observed receiver"
    Assert (@($script:posted | Where-Object { $_.hwnd -ne [IntPtr]202 }).Count -eq 0) "A key escaped its observed receiver"
}
Case "Current observed receiver permits exactly one key pair" {
    Reset-TestState
    Send-Key ([IntPtr]101) "left"
    Assert ($script:dispatched -and $script:posted.Count -eq 2 -and $script:posted[0].message -eq $WM_KEYDOWN -and $script:posted[1].message -eq $WM_KEYUP) "Current receiver did not receive exactly one key pair"
    Assert (@($script:posted | Where-Object { $_.hwnd -ne [IntPtr]202 }).Count -eq 0) "A key escaped its observed receiver"
}
Case "Receiver change after key-down cannot redirect or replay the key" {
    Reset-TestState; $script:keyboardChangeAt = 3
    $failed = $false
    try { Send-Key ([IntPtr]101) "left" } catch { $failed = $true }
    Assert ($failed -and $script:dispatched) "Partial key lost its uncertain dispatch state"
    Assert (@($script:posted | Where-Object { $_.message -eq $WM_KEYDOWN }).Count -eq 1) "A changed receiver replayed key-down"
    Assert (@($script:posted | Where-Object { $_.hwnd -ne [IntPtr]202 }).Count -eq 0) "Cleanup targeted the newly focused receiver"
}
Case "UIA provider exception is treated as uncertain dispatch without a retry" {
    Reset-TestState
    $script:providerCalls = 0
    try { Invoke-UIAMutation { $script:providerCalls++; throw "provider response failed" } } catch {}
    Assert ($script:providerCalls -eq 1 -and $script:dispatched) "UIA provider exception lost its uncertain dispatch state"
    Assert ($script:posted.Count -eq 0) "UIA exception silently fell back to pointer messages"
}
Case "Message failure after button-down cannot replay the click" {
    Reset-TestState; $script:failPostAt = 3
    $failed = $false
    try { Send-MouseClick ([IntPtr]101) 100 200 "left" 1 } catch { $failed = $true }
    Assert ($failed -and $script:dispatched) "Partial delivery was reported as unsent"
    Assert (@($script:posted | Where-Object { $_.message -eq 0x0201 }).Count -eq 1) "The button press was replayed"
    Assert (@($script:posted | Where-Object { $_.hwnd -ne [IntPtr]202 }).Count -eq 0) "A message escaped the chosen receiver"
}
Case "Intervention after button-down yields with dispatched=true and no second press" {
    Reset-TestState; $script:yieldAt = 3
    try { Send-MouseClick ([IntPtr]101) 100 200 "left" 1 } catch {}
    Assert ($script:focusGuardYield -and $script:dispatched) "After-dispatch intervention lost its dispatch marker"
    Assert (@($script:posted | Where-Object { $_.message -eq 0x0201 }).Count -eq 1) "Takeover retried the original click"
}
Case "Modifier shortcuts fail before native delivery" {
    Reset-TestState; $failed = $false
    try { Send-Key ([IntPtr]101) "Ctrl+V" } catch { $failed = $true }
    Assert ($failed -and -not $script:dispatched -and $script:posted.Count -eq 0) "Unsupported combo sent partial keys"
}
Case "UIA double-click cannot issue two asynchronous Invoke requests" {
    Reset-TestState
    $handled = Invoke-PreferredClick ([pscustomobject]@{}) 2
    Assert (-not $handled -and -not $script:dispatched) "Double-click was converted into repeated semantic actions"
}
Case "The same UIA object survives label, value, state and document changes but not a type, HWND or move" {
    $observed = [pscustomobject]@{ name = "Save"; controlType = "ControlType.Button"; nativeWindowHandle = 0; value = ""
        frame = [pscustomobject]@{ x = 10; y = 20; width = 30; height = 40 }; actions = @("Invoke")
        stateSignature = "complete-own-state"; contextProof = "document-proof"; contextScoped = $true }
    foreach ($change in @("none", "name", "value", "actions", "stateSignature", "contextProof", "contextScoped", "missing proofs", "resized around its center")) {
        $live = $observed.PSObject.Copy()
        switch ($change) {
            "name" { $live.name = "Save (2)" }
            "value" { $live.value = "typed since observation" }
            "actions" { $live.actions = @("Invoke", "Toggle") }
            "stateSignature" { $live.stateSignature = "changed" }
            "contextProof" { $live.contextProof = "document text changed" }
            "contextScoped" { $live.contextScoped = $false }
            "missing proofs" { $live.stateSignature = ""; $live.contextProof = "" }
            "resized around its center" { $live.frame = [pscustomobject]@{ x = 8; y = 20; width = 36; height = 40 } }
        }
        Assert-ElementRecordMatches $live $observed
    }
    foreach ($change in @("controlType", "nativeWindowHandle", "moved", "frame lost")) {
        $live = $observed.PSObject.Copy()
        switch ($change) {
            "controlType" { $live.controlType = "ControlType.Text" }
            "nativeWindowHandle" { $live.nativeWindowHandle = 303 }
            "moved" { $live.frame = [pscustomobject]@{ x = 60; y = 20; width = 30; height = 40 } }
            "frame lost" { $live.frame = $null }
        }
        $rejected = $false
        try { Assert-ElementRecordMatches $live $observed } catch { $rejected = $true }
        Assert $rejected "A UIA $change change was accepted"
    }
}

function New-StateTestElement([string]$name, [string]$value, [bool]$enabled, [string]$toggle) {
    $element = [pscustomobject]@{ Current = [pscustomobject]@{ Name = $name; IsEnabled = $enabled; IsKeyboardFocusable = $true }; Value = $value; Toggle = $toggle }
    $element | Add-Member ScriptMethod GetSupportedPatterns {
        @([pscustomobject]@{ ProgrammaticName = "ValuePatternIdentifiers.Pattern" }, [pscustomobject]@{ ProgrammaticName = "TogglePatternIdentifiers.Pattern" })
    }
    $element | Add-Member ScriptMethod GetCurrentPattern { param($pattern)
        if ($pattern.ProgrammaticName -eq "ValuePatternIdentifiers.Pattern") { return [pscustomobject]@{ Current = [pscustomobject]@{ Value = $this.Value; IsReadOnly = $false } } }
        return [pscustomobject]@{ Current = [pscustomobject]@{ ToggleState = $this.Toggle } }
    }
    return $element
}
Case "Complete target state hashes untruncated content and enabled/toggle state" {
    $prefix = "shared displayed prefix"
    $original = New-StateTestElement ($prefix + " old-name") ($prefix + " old-value") $true "Off"
    $signature = Get-ElementStateSignature $original
    Assert (-not [string]::IsNullOrEmpty($signature)) "Complete target state was unavailable"
    foreach ($changed in @(
        (New-StateTestElement ($prefix + " new-name") ($prefix + " old-value") $true "Off"),
        (New-StateTestElement ($prefix + " old-name") ($prefix + " new-value") $true "Off"),
        (New-StateTestElement ($prefix + " old-name") ($prefix + " old-value") $false "Off"),
        (New-StateTestElement ($prefix + " old-name") ($prefix + " old-value") $true "On"))) {
        Assert ((Get-ElementStateSignature $changed) -cne $signature) "Complete own-target change did not affect the hash"
    }
    Assert (-not $signature.Contains($prefix)) "Untruncated target text leaked into the signature"
}
Case "The quiet interval is five seconds and other windows can remain active" {
    Reset-TestState
    $a = [pscustomobject]@{ hwnd = [IntPtr]101; processId = 500; inputTick = 100; idleMilliseconds = 4999 }
    $blocked = $false
    try { Assert-SafeBeforeAction $a 500 ([IntPtr]101) } catch { $blocked = $true }
    Assert $blocked "Target input became eligible before five quiet seconds"
    Reset-TestState
    $a.idleMilliseconds = 5000
    Assert-SafeBeforeAction $a 500 ([IntPtr]101)
    Assert (-not $script:focusGuardYield) "An idle target was permanently paused"
}
Case "Input during result capture yields after dispatch only for the bound target" {
    Reset-TestState; $script:dispatched = $true
    $before = [pscustomobject]@{ hwnd = [IntPtr]102; processId = 500; inputTick = 100 }
    $script:testFocus = [pscustomobject]@{ hwnd = [IntPtr]101; processId = 500; inputTick = 101 }
    function Read-FocusState { $script:testFocus }
    $yielded = $false
    try { Assert-SafeAfterAction $before 500 ([IntPtr]101) } catch { $yielded = $true }
    Assert ($yielded -and $script:focusGuardYield -and $script:dispatched) "Result capture intervention was lost"
    Reset-TestState
    $script:testFocus = [pscustomobject]@{ hwnd = [IntPtr]102; processId = 500; inputTick = 101 }
    Assert-SafeAfterAction $before 500 ([IntPtr]101)
    Assert (-not $script:focusGuardYield) "User input in another app window aborted the target"
}
Case "Real input is confined to explicit foreground input; no attachment, root-external lookup, or screenshot fallback remains" {
    foreach ($forbidden in @("SendMouse", "SendUnicode", "SendVirtualKey", "AttachThreadInput", "AllowSetForegroundWindow", "CopyFromScreen", "Get-MainElement", "Get-DialogWindow")) {
        Assert (-not [regex]::IsMatch($source, "\b$([regex]::Escape($forbidden))\b")) "Forbidden fallback remains: $forbidden"
    }
    $foregroundClass = [regex]::Match($native.Groups[1].Value, '(?s)public static class OCUForegroundInput \{.*\z').Value
    Assert ($foregroundClass.Length -gt 0) "The foreground input class is missing"
    $outsideClass = $source.Replace($foregroundClass, "")
    foreach ($realInput in @("SendInput", "SetCursorPos", "WindowFromPoint")) {
        Assert (-not [regex]::IsMatch($outsideClass, "\b$realInput\b")) "Real input escaped the foreground click: $realInput"
    }
    $wrappers = @("Test-ForegroundInputHeld", "Test-ForegroundButtonHeld", "Read-PointerPosition", "Restore-PointerPosition",
        "Get-TopWindowAtPoint", "Send-ForegroundClaim", "Send-RealPointerClick", "Send-RealText", "Send-RealKeys", "Set-ForegroundWindowTo")
    $session = @("Wait-ForegroundClickPause", "Get-ForegroundClickReadiness", "Get-ForegroundClickReturn", "Complete-ForegroundClick",
        "Start-ForegroundSession", "Enter-ForegroundSession", "Send-ForegroundClick", "Send-ForegroundKeyboard")
    foreach ($definition in $definitions | Where-Object { $_.Body.Extent.Text.Contains("[OCUForegroundInput]::") }) {
        Assert ($wrappers.Contains($definition.Name)) "Real input escaped its native boundary: $($definition.Name)"
    }
    foreach ($definition in $definitions | Where-Object { -not $wrappers.Contains($_.Name) }) {
        foreach ($wrapper in $wrappers) {
            if ([regex]::IsMatch($definition.Body.Extent.Text, "\b$([regex]::Escape($wrapper))\b")) {
                Assert ($session.Contains($definition.Name)) "$($definition.Name) uses foreground input outside explicit foreground input"
            }
        }
    }
    foreach ($definition in $definitions | Where-Object { $_.Body.Extent.Text.Contains("::SetForegroundWindow(") }) {
        Assert (@("Assert-SafeAfterAction", "Reveal-Window", "Set-ForegroundWindowTo").Contains($definition.Name)) "Foreground mutation escaped explicit reveal/strict undo/foreground click"
    }
    $entry = $source.Substring($source.IndexOf('$operationJson = '))
    Assert ([regex]::Matches($entry, '\bSend-ForegroundClick\b').Count -eq 1 -and $entry.Contains('if ($operation.foreground -eq $true) {')) "The foreground click is not gated by an explicit request"
    Assert (@($definitions | Where-Object { $_.Name -ne "Send-ForegroundClick" -and [regex]::IsMatch($_.Body.Extent.Text, '\bSend-ForegroundClick\b') }).Count -eq 0) "Another operation reaches the foreground click"
    $keyboardCalls = [regex]::Matches($entry, '\bSend-ForegroundKeyboard\b').Count
    $gatedKeyboardCalls = [regex]::Matches($entry, 'if \(\$operation\.foreground -eq \$true\) \{ Send-ForegroundKeyboard\b').Count
    Assert ($keyboardCalls -eq 2 -and $gatedKeyboardCalls -eq 2) "Foreground typing or keys are not gated by an explicit request"
    Assert (@($definitions | Where-Object { $_.Name -ne "Send-ForegroundKeyboard" -and [regex]::IsMatch($_.Body.Extent.Text, '\bSend-ForegroundKeyboard\b') }).Count -eq 0) "Another operation reaches foreground keyboard input"
    $find = ($definitions | Where-Object Name -eq "Find-Element").Body.Extent.Text
    Assert ($find.Contains("Same-RuntimeId") -and $find.Contains("Test-ElementInRoot")) "Element lookup lost exact root/runtime identity"
    Assert (-not $find.Contains("sameName") -and -not $find.Contains("sameAutomationId")) "Element lookup retained fuzzy fallback"
    Assert (-not $source.Contains("focusGuardStop")) "Temporary intervention remains a permanent-stop signal"
}

# Identity fixtures replace only read-only OS metadata boundaries. The actual
# identity/alias selection and PID binding functions above stay under test.
$script:testAppIds = @{}
$script:testVersionNames = @{}
$script:testInstalledEntries = @()
$script:testMetadataNames = @{}
$script:testProcesses = @()
$script:launched = New-Object 'Collections.Generic.List[string]'
$script:onLaunch = {}
function Get-ProcessAppUserModelId($process) { return $script:testAppIds[[int]$process.Id] }
function Get-ProcessVersionNames($process) { return @($script:testVersionNames[[int]$process.Id]) }
function Read-InstalledAppEntries { return @($script:testInstalledEntries) }
function Read-InstalledAppMetadataNames($app) { return @($script:testMetadataNames[[string]$app.launchId]) }
function Get-AppWindow($process) {
    if ($null -eq $process -or $null -eq $process.MainWindowHandle) { return [IntPtr]::Zero }
    return [IntPtr][long]$process.MainWindowHandle
}
function Start-InstalledApp([string]$launchId) { $script:launched.Add($launchId); & $script:onLaunch }
function Get-Process([int]$Id = 0) {
    if ($Id -gt 0) { return $script:testProcesses | Where-Object { $_.Id -eq $Id } }
    return @($script:testProcesses)
}

Case "Localized packaged app identity comes from the running PID and installed app metadata" {
    $script:testAppIds = @{ 711 = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }
    $script:testVersionNames = @{ 711 = @('Calculator', 'Microsoft Calculator') }
    $script:testInstalledEntries = @([pscustomobject]@{ launchId = $script:testAppIds[711]; name = ([string][char]0x8ba1 + [char]0x7b97 + [char]0x5668) })
    $script:testProcesses = @([pscustomobject]@{ ProcessName = 'CalculatorApp'; Id = 711; MainWindowHandle = 123
        MainWindowTitle = 'private document title'; Path = 'C:\not-returned\CalculatorApp.exe' })
    $listing = List-Apps
    $app = $listing.runningApps.apps[0]
    Assert ($listing.runningApps.version -eq 1 -and $listing.runningApps.apps.Count -eq 1) "Running app protocol is incomplete"
    Assert ($app.appId -eq $script:testAppIds[711] -and $app.pid -eq 711 -and $app.processName -eq 'CalculatorApp') "Installed name was not bound to its running process"
    Assert ($app.displayName -eq $script:testInstalledEntries[0].name -and $app.aliases.Contains('Calculator')) "Localized installed name or executable alias was lost"
    $json = $listing | ConvertTo-Json -Depth 6
    Assert (-not $json.Contains('private document title') -and -not $json.Contains('not-returned')) "A document title or executable path leaked into app identity"
}
Case "Desktop aliases use executable metadata and never a spoofed window title" {
    $script:testAppIds = @{}
    $script:testVersionNames = @{ 712 = @('Notepad', "Injected`napp", '') }
    $process = [pscustomobject]@{ ProcessName = 'notepad'; Id = 712; MainWindowTitle = 'Calculator' }
    $app = Get-RunningAppIdentity $process @([pscustomobject]@{ appId = 'different-package!App'; displayName = 'Calculator' })
    Assert ($app.appId -eq 'notepad' -and $app.displayName -eq 'Notepad' -and $app.aliases.Count -eq 1) "Unrelated installed app or malformed executable text became an alias"
    Assert (-not $app.aliases.Contains('Calculator')) "A spoofed document title became an app selector"
    $app = Get-RunningAppIdentity $process @([pscustomobject]@{ appId = 'notepad'; displayName = "Injected`napp" })
    Assert ($app.displayName -eq 'Notepad') "A malformed installed app name displaced the executable metadata"
}
Case "Native app selectors resolve the unique installed name AUMID process name or PID" {
    $script:operation = [pscustomobject]@{ expected_app_id = ''; window_id = 123 }
    $script:testAppIds = @{ 711 = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }
    $script:testVersionNames = @{ 711 = @('Calculator', 'Microsoft Calculator') }
    $localizedName = ([string][char]0x8ba1 + [char]0x7b97 + [char]0x5668)
    $script:testInstalledEntries = @([pscustomobject]@{ launchId = $script:testAppIds[711]; name = $localizedName })
    $script:testProcesses = @([pscustomobject]@{ ProcessName = 'CalculatorApp'; Id = 711; MainWindowHandle = 123; MainWindowTitle = 'spoofed document title' })
    foreach ($selector in @($script:testAppIds[711], $localizedName, 'Calculator', 'CalculatorApp', 'CalculatorApp.exe', '711')) {
        $resolved = Resolve-App $selector
        Assert ($resolved.Id -eq 711) "A listed exact selector did not resolve its running process: $selector"
    }
    foreach ($selector in @('spoofed document title', 'Calculat')) {
        $rejected = $false
        try { [void](Resolve-App $selector) } catch { $rejected = $true }
        Assert $rejected "A document title or substring became an app selector"
    }
    $script:testProcesses += [pscustomobject]@{ ProcessName = 'CalculatorApp'; Id = 714; MainWindowHandle = 124; MainWindowTitle = 'other' }
    $script:testAppIds[714] = $script:testAppIds[711]
    foreach ($selector in @($localizedName, $script:testAppIds[711], 'CalculatorApp')) {
        $rejected = $false
        try { [void](Resolve-App $selector) } catch { $rejected = $true }
        Assert $rejected "Ambiguous app instances were silently selected"
    }
    Assert ((Resolve-App '714').Id -eq 714) "Exact PID could not disambiguate the running app"
}
Case "Memmy is discoverable and remains bound to its approved PID and app identity" {
    foreach ($appId in @('cn.memtensor.memmy', 'Memmy')) {
        Reset-TestState
        $script:operation = [pscustomobject]@{ expected_app_id = $appId; window_id = 123 }
        $script:testAppIds = @{ 3001 = $appId }
        $script:testVersionNames = @{ 3001 = @('Memmy') }
        $script:testInstalledEntries = @([pscustomobject]@{ launchId = $appId; name = 'Memmy' })
        $script:testProcesses = @([pscustomobject]@{ ProcessName = 'Memmy'; Id = 3001; MainWindowHandle = 123; MainWindowTitle = 'untrusted chat title' })
        $listing = List-Apps
        Assert ($listing.runningApps.apps.Count -eq 1 -and $listing.runningApps.apps[0].appId -eq $appId) "Memmy was omitted from the native app listing"
        foreach ($selector in @('Memmy', 'Memmy.exe', '3001')) {
            Assert ((Resolve-App $selector 3001).Id -eq 3001) "Approved Memmy selector could not resolve its PID: $selector"
        }
        $script:testAppIds[3001] = 'different-package!App'
        $rejected = $false
        try { [void](Resolve-App '3001' 3001) } catch { $rejected = $true }
        Assert ($rejected -and -not $script:dispatched -and $script:posted.Count -eq 0) "A reused Memmy PID with another identity permitted input"
    }
}
Case "Shared ApplicationFrameHost and protected terminal processes are excluded" {
    $script:testAppIds = @{ 713 = 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' }
    foreach ($name in @('ApplicationFrameHost', 'CMD', 'PowerShell', 'pwsh', 'wt', 'WindowsTerminal', 'ChatGPT')) {
        $app = Get-RunningAppIdentity ([pscustomobject]@{ ProcessName = $name; Id = 713; MainWindowTitle = 'Calculator' }) @()
        Assert ($null -eq $app) "A shared or protected process was discoverable: $name"
    }
}
Case "Approved app ID is checked again when an exact PID has changed identity" {
    Reset-TestState
    $script:operation = [pscustomobject]@{ expected_app_id = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'; window_id = 123 }
    $script:testProcesses = @([pscustomobject]@{ ProcessName = 'CalculatorApp'; Id = 711; MainWindowHandle = 123 })
    $script:testAppIds = @{ 711 = $script:operation.expected_app_id }
    $resolved = Resolve-App '711' 711
    Assert ($resolved.Id -eq 711) "The approved exact process was rejected"
    $script:testAppIds[711] = 'different-package!App'
    $rejected = $false
    try { [void](Resolve-App '711' 711) } catch { $rejected = $true }
    Assert ($rejected -and -not $script:dispatched -and $script:posted.Count -eq 0) "Changed PID app identity permitted input"
    $script:testProcesses = @()
    $rejected = $false
    try { Assert-ExpectedAppIdentity $null $script:operation.expected_app_id } catch { $rejected = $true }
    Assert $rejected "An unavailable process identity was accepted"
}
Case "Every input dispatch rechecks the authorized application identity" {
    $dispatch = ($definitions | Where-Object Name -eq 'Assert-DispatchSafe').Body.Extent.Text
    Assert ($dispatch.Contains('Get-Process -Id $script:targetProcessId') -and $dispatch.Contains('Assert-ExpectedAppIdentity')) "Input dispatch only checked the earlier PID observation"
    $identity = ($definitions | Where-Object Name -eq 'Get-RunningAppIdentity').Body.Extent.Text
    Assert (-not $identity.Contains('MainWindowTitle')) "App aliases trust a window title"
    $version = ($definitions | Where-Object Name -eq 'Get-ProcessVersionNames').Body.Extent.Text
    Assert ($version.Contains('$process.Path') -and $version.Contains('FileVersionInfo')) "Desktop aliases do not use the actual process executable"
}

$script:weixinName = ([string][char]0x5fae + [char]0x4fe1)
function Set-InstalledAppFixture {
    Reset-TestState
    $script:operation = [pscustomobject]@{ expected_app_id = ''; deadline_epoch_ms = $script:testEpochMilliseconds + 60000 }
    $script:launched.Clear()
    $script:onLaunch = {}
    $script:testAppIds = @{}
    $script:testVersionNames = @{}
    $script:testMetadataNames = @{}
    $script:testInstalledEntries = @(
        [pscustomobject]@{ name = $script:weixinName; launchId = '{6D809377-6AF0-444B-8957-A3773F02200E}\Tencent\Weixin\Weixin.exe' },
        [pscustomobject]@{ name = 'Notepad'; launchId = 'Microsoft.Windows.Notepad.Desktop'; target = 'C:\Windows\System32\notepad.exe' },
        [pscustomobject]@{ name = 'Paint'; launchId = 'Microsoft.Paint_8wekyb3d8bbwe!App' },
        [pscustomobject]@{ name = 'Windows PowerShell'; launchId = 'Microsoft.PowerShell.Legacy'; target = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' },
        [pscustomobject]@{ name = 'Same'; launchId = 'C:\Apps\First\first.exe' },
        [pscustomobject]@{ name = 'Same'; launchId = 'C:\Apps\Second\second.exe' })
    $script:testProcesses = @(
        [pscustomobject]@{ ProcessName = 'Weixin'; Id = 900 },
        [pscustomobject]@{ ProcessName = 'svchost'; Id = 4 },
        [pscustomobject]@{ ProcessName = 'notepad'; Id = 901; MainWindowHandle = 77 })
}
Case "Installed entries carry the identity their opened process reports" {
    Assert ((Get-InstalledAppIdentity 'Microsoft.Paint_8wekyb3d8bbwe!App' $null) -eq 'Microsoft.Paint_8wekyb3d8bbwe!App') "A packaged app lost its AUMID"
    Assert ((Get-InstalledAppIdentity '{6D809377-6AF0-444B-8957-A3773F02200E}\Tencent\Weixin\Weixin.exe' $null) -eq 'Weixin') "A desktop program path did not name its process"
    Assert ((Get-InstalledAppIdentity 'Microsoft.Windows.Explorer' 'C:\Windows\explorer.exe') -eq 'explorer') "A shortcut AUMID did not use its target program"
    foreach ($unknown in @(@('Chrome', $null), @('https://example.com/', $null), @('bad id!with space', $null), @('Help', 'C:\Docs\guide.pdf'))) {
        Assert ($null -eq (Get-InstalledAppIdentity $unknown[0] $unknown[1])) "An entry with no predictable process got an identity: $($unknown[0])"
    }
    $script:testInstalledEntries = @([pscustomobject]@{ name = "Bad`nname"; launchId = 'C:\x\bad.exe' },
        [pscustomobject]@{ name = 'Quoted'; launchId = 'C:\x\"q".exe' })
    Assert (@(Get-InstalledApps).Count -eq 0) "A malformed installed name or launch ID was accepted"
}
Case "Read-only resolution covers windowless and installed apps without opening them" {
    Set-InstalledAppFixture
    foreach ($query in @($script:weixinName, 'Weixin', 'Weixin.exe')) {
        $resolved = Resolve-AppIdentity $query
        Assert ($resolved.status -eq 'resolved' -and $resolved.app.appId -eq 'Weixin' -and $resolved.app.displayName -eq $script:weixinName -and $null -eq $resolved.pid) "A windowless app with a Start entry did not resolve without a PID: $query"
    }
    foreach ($query in @('Notepad', 'notepad.exe', '901')) {
        $resolved = Resolve-AppIdentity $query
        Assert ($resolved.status -eq 'resolved' -and $resolved.app.appId -eq 'notepad' -and $resolved.pid -eq 901) "A windowed app did not bind to its PID: $query"
    }
    Assert ((Resolve-AppIdentity 'Paint').app.appId -eq 'Microsoft.Paint_8wekyb3d8bbwe!App') "An installed packaged app did not resolve"
    Assert ((Resolve-AppIdentity 'svchost').status -eq 'not-found') "A background process without a window or Start entry resolved"
    Assert ((Resolve-AppIdentity 'Windows PowerShell').status -eq 'blocked') "A protected app resolved through its Start entry"
    Assert ((Resolve-AppIdentity 'Same').status -eq 'ambiguous') "Two installed apps sharing a name resolved to one"
    Assert ((Resolve-AppIdentity 'Missing').status -eq 'not-found') "An unknown app resolved"
    Assert ($script:launched.Count -eq 0) "Resolution opened an app"
}
Case "Opening an app uses its Start entry and binds to the approved identity's new window" {
    Set-InstalledAppFixture
    $script:operation.expected_app_id = 'Weixin'
    $script:onLaunch = { $script:testProcesses[0] | Add-Member -NotePropertyName MainWindowHandle -NotePropertyValue 88 -Force }
    $opened = Resolve-App 'Weixin'
    Assert ($opened.Id -eq 900) "The opened app did not bind to its process"
    Assert ($script:launched.Count -eq 1 -and $script:launched[0] -eq $script:testInstalledEntries[0].launchId) "The app was not opened through its Start entry"

    Set-InstalledAppFixture
    $script:operation.expected_app_id = 'notepad'
    $rejected = $false
    try { [void](Resolve-App $script:weixinName) } catch { $rejected = $true }
    Assert ($rejected -and $script:launched.Count -eq 0) "An app other than the approved identity was opened"

    Set-InstalledAppFixture
    $rejected = $false
    try { [void](Resolve-App 'Windows PowerShell') } catch { $rejected = $true }
    Assert ($rejected -and $script:launched.Count -eq 0) "A protected app was opened"

    Set-InstalledAppFixture
    $script:operation.deadline_epoch_ms = $script:testEpochMilliseconds + 4000
    $script:onLaunch = { $script:testEpochMilliseconds += 2000 }
    $rejected = $false
    try { [void](Resolve-App 'Paint') } catch { $rejected = $_.Exception.Message.Contains('did not appear') }
    Assert ($rejected -and $script:launched.Count -eq 1) "A missing window after opening was not reported"
}
Case "Installed apps also resolve by the names their own package or executable gives them" {
    Set-InstalledAppFixture
    $calculatorId = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'
    $calculatorName = ([string][char]0x8ba1 + [char]0x7b97 + [char]0x5668)
    $script:testInstalledEntries += [pscustomobject]@{ name = $calculatorName; launchId = $calculatorId }
    $script:testMetadataNames = @{ $calculatorId = @('Calculator', "Injected`nname")
        '{6D809377-6AF0-444B-8957-A3773F02200E}\Tencent\Weixin\Weixin.exe' = @('Paint')
        'C:\Apps\First\first.exe' = @('Shared Product'); 'C:\Apps\Second\second.exe' = @('Shared Product') }
    $resolved = Resolve-AppIdentity 'calculator'
    Assert ($resolved.status -eq 'resolved' -and $resolved.app.appId -eq $calculatorId -and $resolved.app.displayName -eq $calculatorName) "A package resource name did not resolve the installed app"
    Assert ((Resolve-AppIdentity 'Paint').app.appId -eq 'Microsoft.Paint_8wekyb3d8bbwe!App') "Another app's metadata name displaced an exact Start menu name"
    Assert ((Resolve-AppIdentity 'Shared Product').status -eq 'ambiguous') "A metadata name shared by two apps resolved to one"
    Assert ((Resolve-AppIdentity "Injected`nname").status -eq 'not-found') "A malformed metadata name became a selector"
    Assert ($script:launched.Count -eq 0) "Resolution opened an app"

    $script:onLaunch = { $script:testProcesses += [pscustomobject]@{ ProcessName = 'CalculatorApp'; Id = 902; MainWindowHandle = 89 }
        $script:testAppIds[902] = $calculatorId }
    $opened = Resolve-App 'Calculator'
    Assert ($opened.Id -eq 902 -and $script:launched.Count -eq 1 -and $script:launched[0] -eq $calculatorId) "The app was not opened through the Start entry its metadata name selects"
    $app = @((List-Apps).runningApps.apps | Where-Object { $_.pid -eq 902 })[0]
    Assert ($app.displayName -eq $calculatorName -and $app.aliases -contains 'Calculator') "The running app lost the name its package gives it"
    Assert ((Resolve-App 'Calculator').Id -eq 902 -and $script:launched.Count -eq 1) "A running app was opened again instead of selected by its metadata name"
}
Case "App windows exclude the shell desktop, owned windows and tool windows such as the taskbar" {
    Assert ([OCUWin32]::IsAppWindowStyle($true, [IntPtr]::Zero, 0x100, $false)) "An ordinary top-level window was rejected"
    Assert (-not [OCUWin32]::IsAppWindowStyle($true, [IntPtr]::Zero, 0x80, $false)) "A tool window counted as the app window"
    Assert (-not [OCUWin32]::IsAppWindowStyle($true, [IntPtr]::Zero, 0, $true)) "The shell desktop counted as the app window"
    $native = [regex]::Match($source, '(?s)public static bool IsAppWindow\(IntPtr hwnd\) \{.*?\n    \}').Value
    Assert ($native.Contains('GetShellWindow()') -and $native.Contains('"WorkerW"')) "Desktop host windows are not excluded from app windows"
    Assert (-not [OCUWin32]::IsAppWindowStyle($true, [IntPtr]7, 0, $false)) "An owned window counted as the app window"
    Assert (-not [OCUWin32]::IsAppWindowStyle($false, [IntPtr]::Zero, 0, $false)) "A hidden window counted as the app window"
    $resolve = ($definitions | Where-Object Name -eq 'Resolve-App').Body.Extent.Text
    Assert (-not $resolve.Contains('Start-Process') -and -not $source.Contains('OPEN_COMPUTER_USE_WINDOWS_ALLOW_APP_LAUNCH')) "App selector text can still be started as a file"
    $start = ($definitions | Where-Object Name -eq 'Start-InstalledApp').Body.Extent.Text
    Assert ($start.Contains('Win32_Process') -and $start.Contains('shell:AppsFolder\') -and -not $start.Contains('Start-Process')) "An opened app would stay inside the helper's kill-on-close job"
}

function Capture-Record([long]$id, [uint32]$processId, [long]$owner, [int]$z,
    [int]$left = 100, [int]$top = 200, [int]$right = 500, [int]$bottom = 500) {
    $record = New-Object OCUWin32+CaptureWindow
    $record.ID = $id; $record.PID = $processId; $record.Owner = $owner; $record.ZOrder = $z
    $record.Visible = $true
    $bounds = New-Object OCUWin32+RECT
    $bounds.Left = $left; $bounds.Top = $top; $bounds.Right = $right; $bounds.Bottom = $bottom
    $record.Bounds = $bounds
    return $record
}
Case "Owned popup capture includes nested owner chains in z order, excluding independent documents and foreign processes" {
    $root = Capture-Record 10 500 0 4
    $popup = Capture-Record 11 500 10 1 150 220 300 400
    $nested = Capture-Record 12 500 11 0 200 240 310 350
    $unrelated = Capture-Record 13 500 0 2 180 230 300 350
    $foreign = Capture-Record 14 900 10 3 180 230 300 350
    $behind = Capture-Record 15 500 10 5 180 230 300 350
    $selected = @([OCUWin32]::SelectOwnedPopupWindows(@($root, $popup, $nested, $unrelated, $foreign, $behind), 10, 500))
    Assert ($selected.Count -eq 2 -and $selected[0].ID -eq 11 -and $selected[1].ID -eq 12) "Popup scope or back-to-front ordering is wrong"
}
Case "Hidden minimized off-crop invalid and cyclic popup windows cannot enter the screenshot" {
    $root = Capture-Record 10 500 0 10
    $hidden = Capture-Record 11 500 10 1; $hidden.Visible = $false
    $minimized = Capture-Record 12 500 10 2; $minimized.Minimized = $true
    $outside = Capture-Record 13 500 10 3 500 200 700 400
    $invalid = Capture-Record 14 500 10 4 300 200 300 400
    $cycleA = Capture-Record 15 500 16 5; $cycleB = Capture-Record 16 500 15 6
    $crossProcess = Capture-Record 17 500 18 7; $foreignOwner = Capture-Record 18 900 10 8
    $selected = @([OCUWin32]::SelectOwnedPopupWindows(@($root, $hidden, $minimized, $outside, $invalid,
        $cycleA, $cycleB, $crossProcess, $foreignOwner), 10, 500))
    Assert ($selected.Count -eq 0) "An unverifiable popup entered the root image"
    $rejected = $false
    try { [void][OCUWin32]::SelectOwnedPopupWindows(@($root, $root), 10, 500) } catch { $rejected = $true }
    Assert $rejected "Duplicate/reused capture identity was accepted"
}
Case "Popup close move reuse and owner changes invalidate a completed capture group" {
    $root = Capture-Record 10 500 0 3
    $popup = Capture-Record 11 500 10 1 150 220 300 400
    Assert ([OCUWin32]::SameCaptureGroup(@($root, $popup), @($root, $popup))) "Unchanged group was rejected"
    Assert (-not [OCUWin32]::SameCaptureGroup(@($root, $popup), @($root))) "Closed popup was accepted"
    foreach ($change in @("bounds", "owner", "pid", "visibility")) {
        $changed = Capture-Record 11 500 10 1 150 220 300 400
        switch ($change) {
            "bounds" { $bounds = $changed.Bounds; $bounds.Left++; $changed.Bounds = $bounds }
            "owner" { $changed.Owner = 99 }
            "pid" { $changed.PID = 900 }
            "visibility" { $changed.Visible = $false }
        }
        Assert (-not [OCUWin32]::SameCaptureGroup(@($root, $popup), @($root, $changed))) "Popup $change change was accepted"
    }
}
Case "Overlapping popup pixels route to the foremost verified popup while uncovered pixels remain in the root" {
    $popup = Capture-Record 11 500 10 1 150 220 300 400
    $nested = Capture-Record 12 500 11 0 200 240 310 350
    Assert ([OCUWin32]::PointCaptureWindow(@($popup, $nested), 10, 250, 250) -eq 12) "Overlapping pixels hit the popup underneath"
    Assert ([OCUWin32]::PointCaptureWindow(@($popup, $nested), 10, 160, 230) -eq 11) "Popup-only pixels hit the root"
    Assert ([OCUWin32]::PointCaptureWindow(@($popup, $nested), 10, 120, 230) -eq 10) "Uncovered pixels escaped the root"
    Assert ([OCUWin32]::PointCaptureWindow(@($popup, $nested), 10, 310, 350) -eq 10) "Exclusive rectangle edges selected a popup"
}
Case "A disabled modal owner permits only coordinates inside an enabled observed popup" {
    Reset-TestState; $script:targetWindow = [IntPtr]10
    $script:operation = [pscustomobject]@{ related_window_ids = @(11L) }
    $script:testCaptureGroup = [pscustomobject]@{ root = (Capture-Record 10 500 0 3); popups = @((Capture-Record 11 500 10 1 150 220 300 400)) }
    $script:operation | Add-Member NoteProperty observed_capture_group_proof (Get-CaptureGroupProof $script:testCaptureGroup.root $script:testCaptureGroup.popups)
    function Read-OwnedCaptureGroup([IntPtr]$root, [int]$processId) { $script:testCaptureGroup }
    function Test-WindowEnabled([IntPtr]$hwnd) { $hwnd -eq [IntPtr]11 }
    Assert ((Resolve-PointCaptureRoot ([IntPtr]10) 200 250) -eq [IntPtr]11) "Enabled owned modal was rejected with its disabled parent"
    $rejected = $false
    try { [void](Resolve-PointCaptureRoot ([IntPtr]10) 120 230) } catch { $rejected = $true }
    Assert $rejected "Disabled underlying root accepted coordinate input"
    $script:operation.related_window_ids = @()
    $rejected = $false
    try { [void](Resolve-PointCaptureRoot ([IntPtr]10) 200 250) } catch { $rejected = $true }
    Assert $rejected "An unobserved popup accepted coordinates from a root-only screenshot"
    $script:operation.related_window_ids = @(11L)
    $script:testCaptureGroup.popups = @()
    $rejected = $false
    try { [void](Resolve-PointCaptureRoot ([IntPtr]10) 200 250) } catch { $rejected = $true }
    Assert $rejected "A closed popup redirected its old coordinates to the root"
}
Case "The screenshot popup proof rejects same-ID movement and owner changes before point resolution" {
    Reset-TestState; $script:targetWindow = [IntPtr]10
    $root = Capture-Record 10 500 0 3
    $popup = Capture-Record 11 500 10 1 150 220 300 400
    $proof = Get-CaptureGroupProof $root @($popup)
    $script:operation = [pscustomobject]@{ related_window_ids = @(11L); observed_capture_group_proof = $proof }
    $script:testCaptureGroup = [pscustomobject]@{ root = $root; popups = @($popup) }
    function Read-OwnedCaptureGroup([IntPtr]$root, [int]$processId) { $script:testCaptureGroup }
    function Test-WindowEnabled([IntPtr]$hwnd) { $true }
    foreach ($change in @("bounds", "owner")) {
        $changed = Capture-Record 11 500 10 1 150 220 300 400
        if ($change -eq "bounds") { $b = $changed.Bounds; $b.Left++; $changed.Bounds = $b } else { $changed.Owner = 99 }
        $script:testCaptureGroup.popups = @($changed)
        $rejected = $false
        try { [void](Resolve-PointCaptureRoot ([IntPtr]10) 200 250) } catch { $rejected = $true }
        Assert $rejected "Same-ID popup $change change bypassed the screenshot proof"
    }
    $root.ZOrder = 8; $popup.ZOrder = 4
    Assert ((Get-CaptureGroupProof $root @($popup)) -ceq $proof) "Unrelated absolute z-order movement invalidated unchanged captured pixels"
}
Case "Disabled-root action permission is limited to coordinate click scroll and drag" {
    Reset-TestState
    function Resolve-TargetWindow($process, $windowID, $expectedBounds = $null, [switch]$AllowDisabled) { $script:disabledRootAllowed = [bool]$AllowDisabled; [IntPtr]101 }
    foreach ($tool in @("click", "scroll", "drag", "type", "press_key", "write_text")) {
        $script:operation = [pscustomobject]@{ tool = $tool; element = $null }
        [void](Resolve-ActionWindow ([pscustomobject]@{ Id = 500 }) $null 101)
        Assert ($script:disabledRootAllowed -eq @("click", "scroll", "drag").Contains($tool)) "Disabled-root permission widened for $tool"
    }
    $script:operation = [pscustomobject]@{ tool = "click"; element = [pscustomobject]@{ index = 1 } }
    [void](Resolve-ActionWindow ([pscustomobject]@{ Id = 500 }) $null 101)
    Assert (-not $script:disabledRootAllowed) "A semantic root write bypassed the disabled-root gate"
    $snapshot = ($definitions | Where-Object Name -eq "Build-Snapshot").Body.Extent.Text
    Assert ($snapshot.Contains("Resolve-TargetWindow") -and $snapshot.Contains("-AllowDisabled")) "Disabled modal owner cannot be observed"
}
Case "Auto coordinate clicks on an owned popup never inspect the underlying root UIA tree" {
    Reset-TestState
    function Resolve-PointCaptureRoot([IntPtr]$root, [int]$screenX, [int]$screenY) { [IntPtr]11 }
    function Get-AllElements($root) { throw "Underlying root UIA lookup must not run" }
    Assert ($null -eq (Find-PointClickElement ([pscustomobject]@{}) 200 250)) "Popup coordinate click used a root semantic element"
}
Case "Foreground intervention in an observed popup yields while other same-process windows remain independent" {
    Reset-TestState; $script:operation | Add-Member NoteProperty related_window_ids @(11L)
    function Test-CaptureRootMembership([IntPtr]$hwnd, [IntPtr]$root, [int]$processId) { $hwnd -eq [IntPtr]11 }
    $focus = [pscustomobject]@{ hwnd = [IntPtr]11; processId = 500; inputTick = 100; idleMilliseconds = 10 }
    $yielded = $false
    try { Assert-SafeBeforeAction $focus 500 ([IntPtr]101) } catch { $yielded = $true }
    Assert ($yielded -and $script:focusGuardYield) "Recent popup input did not yield"
    Reset-TestState; $script:operation | Add-Member NoteProperty related_window_ids @(11L)
    $focus.hwnd = [IntPtr]12
    Assert-SafeBeforeAction $focus 500 ([IntPtr]101)
    Assert (-not $script:focusGuardYield) "Another document was treated as the bound popup"
    $focus.hwnd = [IntPtr]11; $focus.processId = 900
    Assert-SafeBeforeAction $focus 500 ([IntPtr]101)
    Assert (-not $script:focusGuardYield) "A reused popup handle with another PID was accepted"
}
Case "Paired cleanup retains identity but is allowed after its popup hides or disables" {
    Reset-TestState
    $script:pointCaptureGroup = [pscustomobject]@{ root = (Capture-Record 101 500 0 3); popups = @((Capture-Record 11 500 101 1)) }
    $script:pointReceiverRoot = [IntPtr]11
    function Read-OwnedCaptureGroup([IntPtr]$root, [int]$processId) { throw "Cleanup must not require the old visible topology" }
    function Test-ReceiverInRoot([IntPtr]$receiver, [IntPtr]$root, [int]$processId) { $receiver -eq [IntPtr]202 -and $root -eq [IntPtr]11 -and $processId -eq 500 }
    function Test-CaptureRootMembership([IntPtr]$hwnd, [IntPtr]$root, [int]$processId) { $hwnd -eq [IntPtr]11 -and $root -eq [IntPtr]101 -and $processId -eq 500 }
    function Test-WindowEnabled([IntPtr]$hwnd) { $false }
    function Test-WindowVisible([IntPtr]$hwnd) { $false }
    & $productionReceiverGuard ([IntPtr]202) -CleanupOnly
    $rejected = $false
    try { & $productionReceiverGuard ([IntPtr]303) -CleanupOnly } catch { $rejected = $true }
    Assert $rejected "Cleanup widened to a new receiver"
    function Test-CaptureRootMembership([IntPtr]$hwnd, [IntPtr]$root, [int]$processId) { $false }
    $rejected = $false
    try { & $productionReceiverGuard ([IntPtr]202) -CleanupOnly } catch { $rejected = $true }
    Assert $rejected "Cleanup survived a changed owner/PID identity"
}
Case "Point message dispatch revalidates the screenshot group after receiver resolution" {
    Reset-TestState
    $root = Capture-Record 101 500 0 3
    $popup = Capture-Record 11 500 101 1
    $script:pointCaptureGroup = [pscustomobject]@{ root = $root; popups = @($popup) }
    $script:pointReceiverRoot = [IntPtr]11
    $script:testCaptureGroup = $script:pointCaptureGroup
    function Read-OwnedCaptureGroup([IntPtr]$root, [int]$processId) { $script:testCaptureGroup }
    function Test-ReceiverInRoot([IntPtr]$receiver, [IntPtr]$root, [int]$processId) { $true }
    function Test-CaptureRootMembership([IntPtr]$hwnd, [IntPtr]$root, [int]$processId) { $true }
    function Test-WindowEnabled([IntPtr]$hwnd) { $true }
    function Test-WindowVisible([IntPtr]$hwnd) { $true }
    & $productionReceiverGuard ([IntPtr]202)
    $moved = Capture-Record 11 500 101 1 101 200 500 500
    $script:testCaptureGroup = [pscustomobject]@{ root = $root; popups = @($moved) }
    $rejected = $false
    try { & $productionReceiverGuard ([IntPtr]202) } catch { $rejected = $true }
    Assert $rejected "Popup movement after point resolution allowed a subsequent message"
}
Case "Popup capture resources release on every failure and a failed overlay never returns root-only pixels" {
    $bitmap = ($definitions | Where-Object Name -eq "Capture-WindowBitmap").Body.Extent.Text
    $capture = ($definitions | Where-Object Name -eq "Capture-WindowPngBase64").Body.Extent.Text
    Assert ($bitmap.Contains("finally") -and $bitmap.Contains("ReleaseHdc") -and $bitmap.Contains("graphics.Dispose()") -and $bitmap.Contains("bitmap.Dispose()")) "Root PrintWindow resources can leak on an exception"
    Assert ($capture.Contains('if ($null -eq $overlay) { return $null }') -and $capture.Contains("overlay.Dispose()") -and $capture.Contains("stream.Dispose()") -and $capture.Contains("bitmap.Dispose()")) "Overlay failure can produce partial pixels or leak capture resources"
}

# A simulated desktop for the explicit foreground click. Window 700 (PID 900) is
# the user's; window 101 (PID 500) is the target; 202 is its receiver at the point.
function Reset-ForegroundDesktop {
    Reset-TestState
    $script:pointReceiverRoot = [IntPtr]101
    $script:expectedWindowBounds = [pscustomobject]@{ x = 0.0; y = 0.0; width = 800.0; height = 600.0 }
    $script:foregroundClick = $null
    $script:desk = [pscustomobject]@{ foreground = [IntPtr]700; foregroundPid = 900; tick = [uint32]1000
        lastInputAt = $script:testEpochMilliseconds - 100000; held = $false; buttonHeld = $false
        pointer = @(5, 6); restoredPointer = $null; topAtPoint = [IntPtr]202; bounds = $script:expectedWindowBounds
        claims = 0; clicks = 0; activations = New-Object 'Collections.Generic.List[long]'; onStep = @()
        typed = New-Object 'Collections.Generic.List[string]'; focusInside = $true }
}
function Send-RealText([string]$text) { $script:desk.typed.Add($text); $script:desk.tick++; $true }
function Send-RealKeys([uint16[]]$modifiers, [uint16]$key, [bool]$extended) {
    $script:desk.typed.Add("keys:" + (@($modifiers) + @($key) -join ",") + ":" + $extended); $script:desk.tick++; $true
}
function Test-ForegroundKeyboardFocus([IntPtr]$hwnd) { $script:desk.focusInside -and $script:desk.foreground -eq $hwnd }
function Invoke-ForegroundTestTyping([string]$text, [string]$key) {
    try { Send-ForegroundKeyboard ([IntPtr]101) $text $key; return $null } catch { return $_.Exception.Message }
}
function Invoke-UserInput { $script:desk.tick++; $script:desk.lastInputAt = $script:testEpochMilliseconds }
function Read-ForegroundClickState {
    [pscustomobject]@{ hwnd = $script:desk.foreground; processId = $script:desk.foregroundPid; inputTick = $script:desk.tick
        idleMilliseconds = [uint32][math]::Max(0, $script:testEpochMilliseconds - $script:desk.lastInputAt) }
}
function Wait-ForegroundClickStep([int]$milliseconds) {
    $script:testEpochMilliseconds += $milliseconds
    foreach ($step in @($script:desk.onStep)) { & $step }
}
function Test-ForegroundInputHeld { $script:desk.held }
function Test-ForegroundButtonHeld { $script:desk.buttonHeld }
function Test-ForegroundOwner([IntPtr]$hwnd, [int]$processId) { $true }
function Read-PointerPosition { $script:desk.pointer }
function Restore-PointerPosition([int]$x, [int]$y) { $script:desk.restoredPointer = @($x, $y) }
function Get-TopWindowAtPoint([int]$x, [int]$y) { $script:desk.topAtPoint }
function Send-ForegroundClaim { $script:desk.claims++; $script:desk.tick++; $true }
function Send-RealPointerClick([int]$x, [int]$y, [string]$button, [int]$count) { $script:desk.clicks++; $script:desk.tick++; $true }
function Show-DeskWindow([IntPtr]$hwnd) {
    $script:desk.foreground = $hwnd
    $script:desk.foregroundPid = if ($hwnd -eq [IntPtr]700) { 900 } elseif ($hwnd -eq [IntPtr]800) { 901 } else { 500 }
}
function Set-ForegroundWindowTo([IntPtr]$hwnd) { $script:desk.activations.Add($hwnd.ToInt64()); Show-DeskWindow $hwnd }
function Get-WindowRectFrame([IntPtr]$hwnd) { $script:desk.bounds }
function Test-ReceiverInRoot([IntPtr]$receiver, [IntPtr]$root, [int]$processId) { $receiver -eq [IntPtr]202 -and $root -eq [IntPtr]101 -and $processId -eq 500 }
function Invoke-ForegroundTestClick {
    try { Send-ForegroundClick ([IntPtr]101) 100 200 "left" 1; return $null } catch { return $_.Exception.Message }
}

Case "An idle user's foreground click activates once, clicks once, and returns the pointer and their window" {
    Reset-ForegroundDesktop
    $failure = Invoke-ForegroundTestClick
    Assert ($null -eq $failure -and $script:dispatched -and $script:desk.clicks -eq 1) "The click was not sent exactly once: $failure"
    Assert (($script:desk.activations -join ",") -eq "101,700") "Activation or hand-back was wrong: $($script:desk.activations -join ',')"
    Assert ($script:desk.foreground -eq [IntPtr]700 -and $script:foregroundClick -eq "returned") "The user's window did not come back"
    Assert (($script:desk.restoredPointer -join ",") -eq "5,6") "The pointer was not returned"
}
Case "A user who keeps typing is never interrupted" {
    Reset-ForegroundDesktop; Invoke-UserInput
    $script:desk.onStep = @({ Invoke-UserInput })
    $failure = Invoke-ForegroundTestClick
    Assert ($null -ne $failure -and $script:focusGuardYield -and -not $script:dispatched) "Continuous typing did not yield before dispatch"
    Assert ($script:desk.claims -eq 0 -and $script:desk.activations.Count -eq 0 -and $script:desk.clicks -eq 0) "Typing was interrupted"
}
Case "A held modifier or button waits like typing" {
    Reset-ForegroundDesktop; $script:desk.held = $true
    $failure = Invoke-ForegroundTestClick
    Assert ($null -ne $failure -and $script:focusGuardYield -and $script:desk.activations.Count -eq 0 -and $script:desk.clicks -eq 0) "A held key joined the click"
}
Case "The click waits for a pause in typing" {
    Reset-ForegroundDesktop; Invoke-UserInput
    $stopsAt = $script:testEpochMilliseconds + 1500
    $script:desk.onStep = @({ if ($script:testEpochMilliseconds -lt $stopsAt) { Invoke-UserInput } })
    function Set-ForegroundWindowTo([IntPtr]$hwnd) {
        if ($script:desk.activations.Count -eq 0) { $script:activatedAt = $script:testEpochMilliseconds }
        $script:desk.activations.Add($hwnd.ToInt64()); Show-DeskWindow $hwnd
    }
    $failure = Invoke-ForegroundTestClick
    Assert ($null -eq $failure -and $script:desk.clicks -eq 1) "A pause did not let the click proceed: $failure"
    Assert ($script:activatedAt -ge $script:desk.lastInputAt + 1000) "Activation came before a full one-second pause"
}
Case "Bringing another app forward during activation wins and nothing is sent" {
    Reset-ForegroundDesktop
    function Set-ForegroundWindowTo([IntPtr]$hwnd) {
        $script:desk.activations.Add($hwnd.ToInt64())
        if ($hwnd -eq [IntPtr]101) { Show-DeskWindow ([IntPtr]800); Invoke-UserInput } else { Show-DeskWindow $hwnd }
    }
    $failure = Invoke-ForegroundTestClick
    Assert ($null -ne $failure -and $script:focusGuardYield -and -not $script:dispatched -and $script:desk.clicks -eq 0) "A click was sent after the user switched apps"
    Assert (($script:desk.activations -join ",") -eq "101" -and $script:desk.foreground -eq [IntPtr]800) "Computer Use fought the user's app switch"
    Assert ($script:foregroundClick -eq "keptForUser") "The user's switch was not reported"
}
Case "Typing right after activation sends nothing and returns the keyboard to the user's window" {
    Reset-ForegroundDesktop
    function Set-ForegroundWindowTo([IntPtr]$hwnd) {
        $script:desk.activations.Add($hwnd.ToInt64()); Show-DeskWindow $hwnd
        if ($hwnd -eq [IntPtr]101) { Invoke-UserInput }
    }
    $failure = Invoke-ForegroundTestClick
    Assert ($null -ne $failure -and $script:focusGuardYield -and $script:desk.clicks -eq 0) "Typing did not stop the click"
    Assert (($script:desk.activations -join ",") -eq "101,700" -and $script:desk.foreground -eq [IntPtr]700) "Typing kept the target in front"
    Assert ($null -eq $script:desk.restoredPointer) "An unsent click moved the pointer"
}
Case "A button held on the target after the click leaves it with the user and the pointer where they put it" {
    Reset-ForegroundDesktop
    function Send-RealPointerClick([int]$x, [int]$y, [string]$button, [int]$count) {
        $script:desk.clicks++; $script:desk.tick++
        $script:desk.onStep = @({ if (-not $script:desk.buttonHeld) { $script:desk.buttonHeld = $true; Invoke-UserInput } })
        $true
    }
    $failure = Invoke-ForegroundTestClick
    Assert ($null -eq $failure -and $script:desk.clicks -eq 1 -and $script:foregroundClick -eq "keptForUser") "A user's press on the target was overridden"
    Assert (($script:desk.activations -join ",") -eq "101" -and $null -eq $script:desk.restoredPointer) "The pointer or foreground was taken from the user"
}
Case "Moving the mouse after the click keeps the pointer there but still returns the user's window" {
    Reset-ForegroundDesktop
    function Send-RealPointerClick([int]$x, [int]$y, [string]$button, [int]$count) {
        $script:desk.clicks++; $script:desk.tick++
        $script:desk.onStep = @({ if (-not $script:moved) { $script:moved = $true; Invoke-UserInput } })
        $true
    }
    $script:moved = $false
    $failure = Invoke-ForegroundTestClick
    Assert ($null -eq $failure -and $null -eq $script:desk.restoredPointer) "The pointer was pulled away from the user"
    Assert ($script:desk.foreground -eq [IntPtr]700 -and $script:foregroundClick -eq "returned") "Pointer movement kept the target in front"
}
Case "A window covering the point sends nothing and returns the foreground" {
    Reset-ForegroundDesktop; $script:desk.topAtPoint = [IntPtr]999
    $failure = Invoke-ForegroundTestClick
    Assert ($null -ne $failure -and $failure.Contains("covers the click point") -and -not $script:dispatched -and $script:desk.clicks -eq 0) "A covered point was clicked"
    Assert ($script:desk.foreground -eq [IntPtr]700 -and $script:foregroundClick -eq "returned") "The foreground was not returned"
}
Case "A declined activation sends nothing" {
    Reset-ForegroundDesktop
    function Set-ForegroundWindowTo([IntPtr]$hwnd) { $script:desk.activations.Add($hwnd.ToInt64()) }
    $failure = Invoke-ForegroundTestClick
    Assert ($null -ne $failure -and $failure.Contains("could not be made the foreground window") -and $script:desk.clicks -eq 0) "A declined activation still clicked"
    Assert ($script:desk.foreground -eq [IntPtr]700 -and $script:foregroundClick -eq "returned") "The user's window was disturbed"
}
Case "A target that comes forward again after the click is handed back once more" {
    Reset-ForegroundDesktop
    $script:reactivated = $false
    $script:desk.onStep = @({
        if (-not $script:reactivated -and $script:desk.activations.Count -eq 2 -and $script:desk.foreground -eq [IntPtr]700) {
            $script:reactivated = $true; Show-DeskWindow ([IntPtr]909)
        }
    })
    $failure = Invoke-ForegroundTestClick
    Assert ($null -eq $failure -and $script:reactivated) "The target did not reactivate in the scenario: $failure"
    Assert (($script:desk.activations -join ",") -eq "101,700,700" -and $script:foregroundClick -eq "returned") "The foreground was not handed back again"
}
Case "A target that keeps taking the foreground is not fought indefinitely" {
    Reset-ForegroundDesktop
    $script:desk.onStep = @({ if ($script:desk.activations.Count -ge 2) { Show-DeskWindow ([IntPtr]909) } })
    $failure = Invoke-ForegroundTestClick
    Assert ($null -eq $failure -and ($script:desk.activations -join ",") -eq "101,700,700") "The hand-back was retried without bound"
    Assert ($script:foregroundClick -eq "notReturned") "A failed hand-back was reported as returned"
}
Case "An already active target is clicked without activation or hand-back" {
    Reset-ForegroundDesktop; Show-DeskWindow ([IntPtr]101)
    $failure = Invoke-ForegroundTestClick
    Assert ($null -eq $failure -and $script:desk.clicks -eq 1 -and $script:desk.claims -eq 0 -and $script:desk.activations.Count -eq 0) "An active target was reactivated"
    Assert ($script:foregroundClick -eq "notNeeded" -and ($script:desk.restoredPointer -join ",") -eq "5,6") "The pointer or result was wrong"
}
Case "This helper's own input that registers late is not mistaken for the user's" {
    Reset-ForegroundDesktop
    $script:pendingOwnInput = 0
    function Send-ForegroundClaim { $script:desk.claims++; $script:pendingOwnInput++; $true }
    function Send-RealPointerClick([int]$x, [int]$y, [string]$button, [int]$count) { $script:desk.clicks++; $script:pendingOwnInput++; $true }
    $script:desk.onStep = @({ if ($script:pendingOwnInput -gt 0) { $script:pendingOwnInput--; $script:desk.tick++ } })
    $failure = Invoke-ForegroundTestClick
    Assert ($null -eq $failure -and $script:desk.clicks -eq 1) "A late own event aborted the click: $failure"
    Assert (($script:desk.restoredPointer -join ",") -eq "5,6" -and $script:foregroundClick -eq "returned") "A late own event kept the pointer or the foreground"
}
Case "An empty claim that never registers as input still lets the click proceed" {
    Reset-ForegroundDesktop
    function Send-ForegroundClaim { $script:desk.claims++; $true }
    $failure = Invoke-ForegroundTestClick
    Assert ($null -eq $failure -and $script:desk.clicks -eq 1 -and $script:foregroundClick -eq "returned") "An unregistered claim blocked the click: $failure"
}
Case "Absolute coordinates land on every pixel of a negative-origin virtual desktop" {
    foreach ($desktop in @(@(-1920, 3840), @(0, 1366), @(-1080, 2160))) {
        $origin = $desktop[0]; $extent = $desktop[1]
        for ($offset = 0; $offset -lt $extent; $offset += 7) {
            $normalized = [OCUForegroundInput]::NormalizedCoordinate($origin + $offset, $origin, $extent)
            Assert ($normalized -ge 0 -and $normalized -le 65535) "Normalized coordinate out of range"
            Assert ([math]::Floor($normalized * $extent / 65536) -eq $offset) "Pixel $offset of $extent maps to another pixel"
        }
    }
    $rejected = $false
    try { [void][OCUForegroundInput]::NormalizedCoordinate(10, 0, 10) } catch { $rejected = $true }
    Assert $rejected "A point outside the virtual desktop was accepted"
}

Case "An idle user's foreground typing activates once, types once into the target, and returns their window without moving the pointer" {
    Reset-ForegroundDesktop
    $failure = Invoke-ForegroundTestTyping "你好上海" ""
    Assert ($null -eq $failure -and $script:dispatched -and ($script:desk.typed -join "|") -eq "你好上海") "The text was not typed exactly once: $failure"
    Assert (($script:desk.activations -join ",") -eq "101,700" -and $script:foregroundClick -eq "returned") "Activation or hand-back was wrong"
    Assert ($null -eq $script:desk.restoredPointer -and $script:desk.clicks -eq 0) "Typing moved the pointer or clicked"
}
Case "A user who keeps typing is never interrupted by foreground typing" {
    Reset-ForegroundDesktop; Invoke-UserInput
    $script:desk.onStep = @({ Invoke-UserInput })
    $failure = Invoke-ForegroundTestTyping "text" ""
    Assert ($null -ne $failure -and $script:focusGuardYield -and -not $script:dispatched) "Continuous typing did not yield before dispatch"
    Assert ($script:desk.activations.Count -eq 0 -and $script:desk.typed.Count -eq 0) "The user's typing was interrupted"
}
Case "Foreground typing sends nothing when the target's keyboard focus is outside it" {
    Reset-ForegroundDesktop; $script:desk.focusInside = $false
    $failure = Invoke-ForegroundTestTyping "text" ""
    Assert ($null -ne $failure -and $failure.Contains("no keyboard focus inside it") -and -not $script:dispatched) "Text was sent without a focus in the target"
    Assert ($script:desk.typed.Count -eq 0 -and $script:desk.foreground -eq [IntPtr]700 -and $script:foregroundClick -eq "returned") "The user's window did not come back"
}
Case "A key chord is pressed with its modifiers in one real input and an active target is not reactivated" {
    Reset-ForegroundDesktop; Show-DeskWindow ([IntPtr]101)
    $failure = Invoke-ForegroundTestTyping "" "ctrl+shift+n"
    Assert ($null -eq $failure -and ($script:desk.typed -join "|") -eq "keys:17,16,78:False") "The chord was not pressed once: $failure $($script:desk.typed -join '|')"
    Assert ($script:desk.activations.Count -eq 0 -and $script:foregroundClick -eq "notNeeded") "An active target was reactivated"
    $arrow = Get-ForegroundKeyChord "Left"
    Assert (@($arrow.modifiers).Count -eq 0 -and $arrow.key -eq 0x25 -and $arrow.extended) "An arrow key lost its extended flag"
    $rejected = $false
    try { [void](Get-ForegroundKeyChord "hyper+a") } catch { $rejected = $true }
    Assert $rejected "An unknown modifier was accepted"
}

$failed = @($results | Where-Object { -not $_.passed })
[pscustomobject]@{ passed = $results.Count - $failed.Count; failed = $failed.Count; tests = $results.ToArray() } | ConvertTo-Json -Depth 6
if ($failed.Count) { exit 1 }
