@echo off
chcp 65001 >nul
title Вопросы аудитории — запуск
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js не найден. Установите его с https://nodejs.org и запустите файл снова.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Устанавливаю зависимости, это нужно только один раз...
  call npm install || goto :error
)

echo.
echo Запускаю сервер и внешнюю ссылку. Первый запуск занимает 10-20 секунд.
echo.
call npm run share

echo.
echo Сервер остановлен.
pause
exit /b 0

:error
echo.
echo Не удалось установить зависимости. Проверьте интернет и запустите файл снова.
pause
exit /b 1
