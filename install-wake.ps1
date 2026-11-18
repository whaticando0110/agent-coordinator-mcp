param(
    [Parameter(Mandatory=$true)][string]$CodexExecutable,
    [Parameter(Mandatory=$true)][string]$AntigravityExecutable,
    [string]$DataDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $DataDirectory) { $DataDirectory = $env:COORDINATOR_DATA_DIR }
if (-not $DataDirectory) { $basePath = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }; $DataDirectory = Join-Path $basePath 'AgentCoordinatorMCP' }
# Install a sidecar using the documented app configuration. Preserve all existing settings.
foreach ($executable in @($CodexExecutable, $AntigravityExecutable)) {
    if (-not [IO.Path]::IsPathRooted($executable) -or -not (Test-Path -LiteralPath $executable -PathType Leaf) -or [IO.Path]::GetExtension($executable) -ne '.exe') {
        throw 'Pass absolute paths to the native codex.exe and Antigravity language_server.exe.'
    }
}
if (-not [IO.Path]::IsPathRooted($DataDirectory)) { throw 'DataDirectory must be absolute.' }
$queueHelp = & $CodexExecutable queue --help 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or ($queueHelp -notmatch '--thread' -or $queueHelp -notmatch '--message')) { throw 'Use the bundled Codex executable with queue support.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
if ([int](& $nodePath -p 'parseInt(process.versions.node)') -lt 24) { throw 'Node.js 24 required.' }
$workerPath = Join-Path $PSScriptRoot 'wake-worker.mjs'
$configRoot = Join-Path $env:USERPROFILE '.gemini/config'
$sidecarRoot = Join-Path $configRoot 'sidecars/agent-coordinator-standalone'
$configFile = Join-Path $configRoot 'config.json'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$utf8 = New-Object System.Text.UTF8Encoding($false)
$settings = @{}
function ConvertTo-Hashtable($value) {
    if ($null -eq $value) { return $null }
    if ($value -is [System.Management.Automation.PSCustomObject]) {
        $result = @{}
        foreach ($property in $value.PSObject.Properties) { $result[$property.Name] = ConvertTo-Hashtable $property.Value }
        return $result
    }
    if ($value -is [System.Array]) { return ,@($value | ForEach-Object { ConvertTo-Hashtable $_ }) }
    return $value
}
if (Test-Path -LiteralPath $configFile) {
    $settings = ConvertTo-Hashtable (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json)
    if ($settings -isnot [hashtable]) { throw 'Antigravity config must be an object.' }
}
if (-not $settings.ContainsKey('sidecars')) { $settings.sidecars = @{} }
if ($settings.sidecars -isnot [hashtable]) { throw 'Existing sidecars configuration must be an object.' }
New-Item -ItemType Directory -Force -Path $sidecarRoot, $DataDirectory | Out-Null
$files = @($configFile, (Join-Path $sidecarRoot 'sidecar.json'), (Join-Path $DataDirectory 'wake-config.json'))
foreach ($file in $files) { if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination "$file.before-wake-$stamp.bak" } }
$bridge = @{ codex = @{ executable = $CodexExecutable }; antigravity = @{ executable = $AntigravityExecutable } }
[IO.File]::WriteAllText((Join-Path $DataDirectory 'wake-config.json'), ($bridge | ConvertTo-Json -Depth 20), $utf8)
$sidecar = @{ command = $nodePath; args = @($workerPath, '--data-dir', $DataDirectory); restart_policy = 'on-failure'; display_name = 'Agent Coordinator MCP'; description = 'Deliver coordinator wake requests to existing Codex and Antigravity chats.' }
[IO.File]::WriteAllText((Join-Path $sidecarRoot 'sidecar.json'), ($sidecar | ConvertTo-Json -Depth 20), $utf8)
if (-not $settings.sidecars.ContainsKey('agent-coordinator-standalone')) { $settings.sidecars['agent-coordinator-standalone'] = @{} }
$settings.sidecars['agent-coordinator-standalone'].enabled = $true
[IO.File]::WriteAllText($configFile, ($settings | ConvertTo-Json -Depth 100), $utf8)
Write-Output 'Installed coordinator sidecar. Reload Antigravity if it is not running yet. Set target chat UUIDs in Coordinator > MCP Connections.'
