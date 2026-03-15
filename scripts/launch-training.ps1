# launch-training.ps1 — Start NEAT training + dashboard server as background processes
# Run from the repo root: .\scripts\launch-training.ps1

$repoRoot = "C:\Users\willt\Documents\Projects\gifflar"
Set-Location $repoRoot

Write-Host "🧬 NEAT Training Launcher" -ForegroundColor Cyan
Write-Host "=========================" -ForegroundColor Cyan

# 1. Start dashboard server
Write-Host "`n📊 Starting dashboard server..." -ForegroundColor Yellow
$dashLog = Join-Path $repoRoot "dashboard.log"
$dashProcess = Start-Process node -ArgumentList "scripts/dashboard-server.js" `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $dashLog `
    -RedirectStandardError $dashLog `
    -PassThru -WindowStyle Hidden
Write-Host "   Dashboard PID: $($dashProcess.Id) → http://localhost:3000" -ForegroundColor Green
Write-Host "   Log: $dashLog"

Start-Sleep -Seconds 2

# 2. Quick health check
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:3000/api/data" -UseBasicParsing -TimeoutSec 5
    Write-Host "   Dashboard health: $($resp.StatusCode) ✅" -ForegroundColor Green
} catch {
    Write-Host "   Dashboard health: ⚠️  $($_.Exception.Message)" -ForegroundColor Yellow
}

# 3. Start NEAT training
Write-Host "`n🧬 Starting NEAT training..." -ForegroundColor Yellow
$trainLog = Join-Path $repoRoot "training.log"
$trainProcess = Start-Process node -ArgumentList "scripts/neat-play.js" `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $trainLog `
    -RedirectStandardError $trainLog `
    -PassThru -WindowStyle Hidden
Write-Host "   Training PID: $($trainProcess.Id)" -ForegroundColor Green
Write-Host "   Log: $trainLog"

# 4. Save PIDs for later management
@{
    dashboard = $dashProcess.Id
    training  = $trainProcess.Id
    started   = (Get-Date -Format "o")
} | ConvertTo-Json | Set-Content "$repoRoot\pids.json"

Write-Host "`n✅ Both processes started!" -ForegroundColor Green
Write-Host "   🌐 Dashboard: http://localhost:3000" -ForegroundColor Cyan
Write-Host "   📋 Training log: tail -f training.log" -ForegroundColor Cyan
Write-Host "   📋 Dashboard log: tail -f dashboard.log" -ForegroundColor Cyan
Write-Host "   📄 PIDs saved to: pids.json" -ForegroundColor Cyan
Write-Host "`n   To stop: Get-Content pids.json | ConvertFrom-Json | % { Stop-Process -Id `$_.dashboard, `$_.training -ErrorAction SilentlyContinue }"
