@echo off
rem Warenavi PlayAuto worker. Restarts itself 10 seconds after it stops.
chcp 65001 > NUL
cd /d "%~dp0"
title Warenavi PlayAuto worker
:loop
py -3 -I playauto_worker.py
echo Worker stopped. Restarting in 10 seconds...
timeout /t 10 /nobreak > NUL
goto loop
