$ErrorActionPreference = 'Continue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function T([int[]]$CodePoints) {
    -join ($CodePoints | ForEach-Object { [char]$_ })
}

$header = '=================================================='
$title = T 0x7ba1, 0x7406, 0x83dc, 0x5355
$items = @(
    ('  1. ' + (T 0x914d, 0x7f6e) + ' Windows ' + (T 0x684c, 0x9762, 0x7aef, 0x8fdc, 0x7a0b) + ' Memory'),
    ('  2. ' + (T 0x542f, 0x52a8) + ' Memory ' + (T 0x670d, 0x52a1)),
    ('  3. ' + (T 0x67e5, 0x770b, 0x670d, 0x52a1, 0x72b6, 0x6001, 0x548c, 0x5065, 0x5eb7, 0x68c0, 0x67e5)),
    ('  4. ' + (T 0x5728, 0x65b0, 0x7a97, 0x53e3) + (T 0x67e5, 0x770b) + (T 0x5b9e, 0x65f6) + (T 0x65e5, 0x5fd7)),
    ('  5. ' + (T 0x91cd, 0x542f) + ' Memory ' + (T 0x670d, 0x52a1)),
    ('  6. ' + (T 0x505c, 0x6b62, 0x670d, 0x52a1, 0xff08, 0x4fdd, 0x7559, 0x6570, 0x636e, 0xff09)),
    ('  7. ' + (T 0x91cd, 0x5efa, 0x955c, 0x50cf, 0x5e76, 0x66f4, 0x65b0, 0x670d, 0x52a1)),
    ('  8. ' + (T 0x5728, 0x6d4f, 0x89c8, 0x5668) + (T 0x6253, 0x5f00) + ' Memory ' + (T 0x9762, 0x677f)),
    ('  0. ' + (T 0x9000, 0x51fa))
)
$prompt = (T 0x8bf7, 0x9009, 0x62e9, 0x64cd, 0x4f5c) + ': '
$returnPrompt = (T 0x6309, 0x56de, 0x8f66) + ' ' + (T 0x8fd4, 0x56de) + '...'
$invalid = T 0x65e0, 0x6548, 0x9009, 0x9879

function Pause-Menu {
    Read-Host $script:returnPrompt | Out-Null
}

function Invoke-Batch([string]$Name) {
    $path = Join-Path $PSScriptRoot $Name
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host ((T 0x627e, 0x4e0d, 0x5230) + ': ' + $path)
        Pause-Menu
        return
    }
    & $path
    if ($LASTEXITCODE -ne 0) {
        Write-Host ((T 0x811a, 0x8bef) + ': ' + $LASTEXITCODE)
    }
}

function Open-Logs {
    $path = Join-Path $PSScriptRoot '03-logs-memory.bat'
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', ('call "{0}"' -f $path)) | Out-Null
}

function Open-Panel {
    $envPath = Join-Path $PSScriptRoot '.env'
    $tokenLine = Get-Content -LiteralPath $envPath -ErrorAction SilentlyContinue |
        Where-Object { $_ -match '^MEMMY_MEMORY_TOKEN=' } |
        Select-Object -First 1
    $token = if ($tokenLine) { $tokenLine.Substring('MEMMY_MEMORY_TOKEN='.Length).Trim() } else { '' }
    if (-not $token) {
        Write-Host ((T 0x627e, 0x4e0d, 0x5230) + ': ' + $envPath + ' -> MEMMY_MEMORY_TOKEN')
        Pause-Menu
        return
    }
    $url = 'http://127.0.0.1:18960/#token=' + [Uri]::EscapeDataString($token)
    Start-Process $url | Out-Null
}

while ($true) {
    Clear-Host
    Write-Host $header
    Write-Host ('             Memmy Memory ' + $title)
    Write-Host $header
    Write-Host ''
    $items | ForEach-Object { Write-Host $_ }
    Write-Host ''

    $choice = (Read-Host $prompt).Trim()
    switch ($choice) {
        '1' { Invoke-Batch '00-configure-desktop.bat' }
        '2' { Invoke-Batch '01-start-memory.bat' }
        '3' { Invoke-Batch '02-status-memory.bat' }
        '4' { Open-Logs }
        '5' { Invoke-Batch '04-restart-memory.bat' }
        '6' { Invoke-Batch '05-stop-memory.bat' }
        '7' { Invoke-Batch '06-update-memory.bat' }
        '8' { Open-Panel }
        '0' { exit 0 }
        default {
            Write-Host $invalid
            Pause-Menu
        }
    }
}
