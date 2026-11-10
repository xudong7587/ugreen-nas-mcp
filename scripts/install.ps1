param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $taskRoot 'server.mjs'
$codexCommand = (Get-Command codex -ErrorAction Stop).Source
if (-not $Remove) {
    $nodeCommand = (Get-Command node -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath $serverPath)) { throw '找不到 server.mjs。' }
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules\@modelcontextprotocol\sdk'))) {
        throw '请先在项目目录运行 npm ci --ignore-scripts。'
    }
}
# Back up the configuration without printing its contents.
$codexConfigHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$configPath = Join-Path $codexConfigHome 'config.toml'
$originalConfigText = ''
if (Test-Path -LiteralPath $configPath) {
    $originalConfigText = [System.IO.File]::ReadAllText($configPath)
    $backupDir = Join-Path $taskRoot 'backups'
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $backupPath = Join-Path $backupDir ('codex-config-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.toml')
    Copy-Item -LiteralPath $configPath -Destination $backupPath
}
$serverTablesPattern = '(?ms)^\[mcp_servers\.ugreen-nas(?:\.[^\]]+)?\][^\S\r\n]*\r?\n.*?(?=^\[|\z)'
if ($Remove) {
    & $codexCommand mcp remove ugreen-nas
    if ($LASTEXITCODE -ne 0) { throw '移除 MCP 注册失败。' }
    if ($originalConfigText) {
        $updatedConfigText = [regex]::Replace($originalConfigText, $serverTablesPattern, '')
        [System.IO.File]::WriteAllText($configPath, $updatedConfigText, [System.Text.UTF8Encoding]::new($false))
    }
    exit 0
}
& $codexCommand mcp add ugreen-nas -- $nodeCommand $serverPath
if ($LASTEXITCODE -ne 0) { throw '注册 MCP 失败。已有配置备份在 backups 目录。' }
# Transfers may use the official gateway's 30-minute budget.
$configText = [System.IO.File]::ReadAllText($configPath)
$sectionPattern = '(?ms)^\[mcp_servers\.ugreen-nas\]\r?\n.*?(?=^\[|\z)'
$section = [regex]::Match($configText, $sectionPattern)
if (-not $section.Success) { throw '未找到刚注册的 ugreen-nas 配置段。' }
$sectionBody = [regex]::Replace($section.Value, '(?m)^(startup_timeout_sec|tool_timeout_sec)\s*=.*\r?\n?', '').TrimEnd()
$newline = if ($configText.Contains("`r`n")) { "`r`n" } else { "`n" }
$replacement = $sectionBody + $newline + 'startup_timeout_sec = 20' + $newline + 'tool_timeout_sec = 1860' + $newline + $newline
# codex mcp add can normalize unrelated empty arrays. Retain the original text
# and replace only this server's table with the verified CLI-generated table.
$originalWithoutServer = [regex]::Replace($originalConfigText, $serverTablesPattern, '')
$updatedConfigText = $originalWithoutServer.TrimEnd() + $newline + $newline + $replacement
[System.IO.File]::WriteAllText($configPath, $updatedConfigText, [System.Text.UTF8Encoding]::new($false))
& $codexCommand mcp get ugreen-nas --json
if ($LASTEXITCODE -ne 0) { throw '读取 MCP 注册失败。' }
