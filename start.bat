@echo off
rem Buurtradar starten: dubbelklik dit bestand. Stoppen: sluit het venster of druk Ctrl+C.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
if errorlevel 1 pause
