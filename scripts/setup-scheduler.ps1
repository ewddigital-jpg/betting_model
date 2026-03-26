# Register Windows Task Scheduler jobs for the betting model
# Run once from PowerShell (Admin not required for current user tasks)

$projectDir = "C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\betting_model"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error "node.exe not found in PATH. Make sure Node.js is installed."
    exit 1
}

# Task 1: Daily at 09:00 — force-odds sync + predicted lineup refresh
$action1 = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c node `"$projectDir\scripts\sync-data.js`" --force-odds && node `"$projectDir\scripts\predict-lineups.js`"" `
    -WorkingDirectory $projectDir

$trigger1 = New-ScheduledTaskTrigger -Daily -At "09:00"

$settings1 = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName "BettingModel-DailyOddsSync" `
    -Action $action1 `
    -Trigger $trigger1 `
    -Settings $settings1 `
    -Description "Daily: fetch CL/EL odds and refresh predicted lineups" `
    -Force | Out-Null

Write-Host "OK: BettingModel-DailyOddsSync registered (daily at 09:00)"

# Task 2: Every 6 hours — force-odds sync for match-window freshness
$action2 = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c node `"$projectDir\scripts\sync-data.js`" --force-odds" `
    -WorkingDirectory $projectDir

$trigger2 = New-ScheduledTaskTrigger -Once -At "00:00" `
    -RepetitionInterval (New-TimeSpan -Hours 6)

$settings2 = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName "BettingModel-MatchdayOddsSync" `
    -Action $action2 `
    -Trigger $trigger2 `
    -Settings $settings2 `
    -Description "Every 6h: force-fetch CL/EL odds for upcoming matches" `
    -Force | Out-Null

Write-Host "OK: BettingModel-MatchdayOddsSync registered (every 6 hours)"
Write-Host ""
Write-Host "Done. View tasks: Task Scheduler > Task Scheduler Library"
