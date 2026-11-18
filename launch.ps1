$ErrorActionPreference = 'Stop'
try {
    $appRoot = $PSScriptRoot
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $nodeMajor = & $nodePath -p 'parseInt(process.versions.node)'
    if ([int]$nodeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
    $config = & $nodePath (Join-Path $appRoot 'doctor.mjs') --launch-config
    if ($LASTEXITCODE -ne 0) { throw 'Invalid coordinator settings. Run npm run doctor in a terminal.' }
    $local = $config | ConvertFrom-Json
    $address = $local.address
    $dataPath = $local.directory
    function Get-CoordinatorHealth {
        try { return Invoke-RestMethod -Uri "$address/api/health" -TimeoutSec 1 }
        catch { return $null }
    }
    function Test-LiveCoordinator {
        $health = Get-CoordinatorHealth
        if (-not $health) { return $false }
        if ($health.app -eq 'agent-coordinator-mcp' -and $health.mode -eq 'live' -and $health.workspace -eq $local.workspace) { return $true }
        throw "Port at $address is responding, but it is not this checkout and data directory. Stop the other process or set COORDINATOR_PORT."
    }
    if (Test-LiveCoordinator) {
        Start-Process $address
        exit
    }
    New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
    if (-not (Test-Path (Join-Path $appRoot 'node_modules/@modelcontextprotocol/server/package.json'))) {
        $npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
        Push-Location $appRoot
        try {
            & $npmPath ci --ignore-scripts --no-audit --no-fund *> (Join-Path $dataPath 'install.log')
            if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed. See $dataPath/install.log" }
        } finally { Pop-Location }
    }
    $scriptPath = Join-Path $appRoot 'server.mjs'
    Start-Process -FilePath $nodePath -ArgumentList ('"' + $scriptPath + '"') -WorkingDirectory $appRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $dataPath 'server.log') -RedirectStandardError (Join-Path $dataPath 'server-error.log') | Out-Null
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Test-LiveCoordinator) {
            Start-Process $address
            exit
        }
    }
    throw "Cannot open the coordinator at $address. See $dataPath/server-error.log"
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Agent Coordinator', 'OK', 'Error') | Out-Null
    exit 1
}
