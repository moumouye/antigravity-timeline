# Antigravity Timeline Navigator - One-line Uninstaller for Windows
Write-Host "==> 正在卸载 Antigravity Timeline 插件..." -ForegroundColor Cyan

# 1. 终止残留 node 进程 (若有)
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*sidecars/engine/main.mjs*" } | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. 移除插件目录或符号链接
$TargetDir = Join-Path $HOME ".gemini\config\plugins\antigravity-timeline"
if (Test-Path $TargetDir) {
    Remove-Item -Recurse -Force $TargetDir
    Write-Host "[OK] 已清理插件目录: $TargetDir" -ForegroundColor Green
}

# 3. 清理数据目录
$DataDir1 = Join-Path $HOME ".gemini\antigravity\sidecar_data\antigravity-timeline"
if (Test-Path $DataDir1) { Remove-Item -Recurse -Force $DataDir1 }

$DataDir2 = Join-Path $HOME ".gemini\antigravity\plugin_data\antigravity-timeline"
if (Test-Path $DataDir2) { Remove-Item -Recurse -Force $DataDir2 }

# 4. 从 config.json 中注销
$ConfigFile = Join-Path $HOME ".gemini\config\config.json"
if (Test-Path $ConfigFile) {
    try {
        $json = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($json.plugins -and $json.plugins.'antigravity-timeline') {
            $json.plugins.PSObject.Properties.Remove('antigravity-timeline')
            $json | ConvertTo-Json -Depth 10 | Set-Content $ConfigFile -Encoding UTF8
        }
    } catch {}
}

Write-Host "🎉 卸载完成（零文件残留）！请重启 Antigravity 客户端以生效。" -ForegroundColor Green
