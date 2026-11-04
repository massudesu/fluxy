@echo off
title Fluxy - backend em C
cd /d "%~dp0"

if not exist fluxy-api.exe (
  echo [Fluxy-C] binario nao encontrado. Rode build.bat primeiro.
  pause
  exit /b 1
)

start "" "http://localhost:8080/index.html"
fluxy-api.exe
pause
