@echo off
chcp 65001 >nul
title Вопросы аудитории — остановка
cd /d "%~dp0"

echo Останавливаю приложение и внешний туннель...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; foreach ($c in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) { $p = Get-Process -Id $c -ErrorAction SilentlyContinue; if ($p) { Write-Host ('  остановлен ' + $p.ProcessName + ' (PID ' + $c + ')'); Stop-Process -Id $c -Force -ErrorAction SilentlyContinue } }; $t = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ssh.exe' -and $_.CommandLine -like '*localhost.run*' }; foreach ($s in $t) { Write-Host ('  остановлен туннель ssh (PID ' + $s.ProcessId + ')'); Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 700; $left = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count; if ($left -eq 0) { Write-Host '  порт 3000 свободен' } else { Write-Host '  на порту 3000 всё ещё что-то слушает' }"

echo.
echo Готово. Внешняя ссылка и QR-код больше не работают, сайт остановлен.
pause
