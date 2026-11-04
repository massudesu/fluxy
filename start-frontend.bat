@echo off
rem Atalho de compatibilidade: o backend e o frontend sao servidos juntos
rem pelo mesmo processo, entao isto apenas chama o iniciador principal.
cd /d "%~dp0"
call "%~dp0INICIAR-FLUXY.bat"
