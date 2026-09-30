# Daftarkan posting otomatis ke Windows Task Scheduler.
# Pakai: powershell -ExecutionPolicy Bypass -File schedule.ps1
# Hapus jadwal: Unregister-ScheduledTask -TaskName "AI Post FB Otomotif" -Confirm:$false

$TaskName = "AI Post FB Otomotif"
$Times = @("08:00", "19:00")

$Dir = $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source

$Action = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument "/c `"`"$Node`" post.js >> post.log 2>&1`"" `
  -WorkingDirectory $Dir

$Triggers = $Times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }

# StartWhenAvailable: kalau laptop mati/tidur saat jadwal, jalankan begitu menyala lagi.
# Default Windows tidak menjalankan task saat pakai baterai, jadi diizinkan eksplisit.
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Settings $Settings -Force | Out-Null
Write-Host "Terjadwal: $TaskName setiap hari jam $($Times -join ', '). Log: $Dir\post.log"
