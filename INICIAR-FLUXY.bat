@echo off
title Fluxy - Sistema local
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Fluxy] Node.js 18 ou superior nao encontrado.
  echo Instale em https://nodejs.org/ e execute este arquivo novamente.
  pause
  exit /b 1
)

if not exist "node_modules\pg" (
  echo [Fluxy] Dependencias nao instaladas. Rode "npm install" nesta pasta uma vez
  echo e execute este arquivo novamente.
  pause
  exit /b 1
)

echo.
echo  ===========================================
echo   Fluxy - iniciando site + API na porta 8080
echo   Abra sempre por aqui (NUNCA pelo index.html)
echo  ===========================================
echo.

node backend\src\index.js

echo.
echo [Fluxy] O servidor foi encerrado.
pause
