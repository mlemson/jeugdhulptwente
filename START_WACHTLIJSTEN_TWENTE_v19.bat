@echo off
setlocal
cd /d "%~dp0"
title Wachtlijsten Zorgaanbieders Twente

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 wachtlijsten_server_v19.py
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  python wachtlijsten_server_v19.py
  goto :eof
)

echo.
echo Python is niet gevonden op deze computer.
echo Installeer Python 3 via python.org en vink bij installatie "Add Python to PATH" aan.
echo Daarna kun je dit bestand opnieuw openen.
echo.
pause
