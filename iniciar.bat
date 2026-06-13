@echo off
title Agenda da Estagiaria - Ana Beatriz
color 0A
cls
echo.
echo  ============================================
echo   Agenda da Estagiaria ^| Ana Beatriz Fonseca
echo  ============================================
echo.

cd /d "%~dp0"

echo  [1/2] Verificando dependencias...
call npm install --silent 2>nul
echo  [1/2] Dependencias ok!

echo  [2/2] Iniciando servidor...
echo.
echo  Acesse: http://localhost:3000
echo  Pressione Ctrl+C para encerrar
echo.

start "" http://localhost:3000
node server.js
pause
