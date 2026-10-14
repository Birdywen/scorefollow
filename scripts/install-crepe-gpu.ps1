param(
    [string]$Root = "C:\Users\friend\crepe-5090",
    [Parameter(Mandatory=$true)][string]$BindAddress,
    [Parameter(Mandatory=$true)][string]$AllowedRemoteAddress,
    [int]$Port = 28763
)
$ErrorActionPreference = 'Stop'
$Python = Join-Path $Root 'Scripts\python.exe'
$Worker = Join-Path $Root 'crepe_gpu_server.py'
$Token = Join-Path $Root 'gpu-token.txt'
foreach ($Path in @($Python, $Worker, $Token)) {
    if (-not (Test-Path $Path)) { throw "Missing required file: $Path" }
}
# Run independently of SSH/logon, restart after failure, and start after reboot.
$Arguments = "-u `"$Worker`" --host $BindAddress --port $Port --token-file `"$Token`" --log-file `"$Root\gpu-service.log`""
$Action = New-ScheduledTaskAction -Execute $Python -Argument $Arguments -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'ScoreFollow-CREPE-GPU' -Action $Action -Trigger $Trigger `
    -Settings $Settings -Principal $Principal -Force | Out-Null
$RuleName = 'ScoreFollow-CREPE-Tailscale'
Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name $RuleName -DisplayName $RuleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalAddress $BindAddress -LocalPort $Port -RemoteAddress $AllowedRemoteAddress | Out-Null
Start-ScheduledTask -TaskName 'ScoreFollow-CREPE-GPU'
Write-Output 'GPU_TASK_INSTALLED'
