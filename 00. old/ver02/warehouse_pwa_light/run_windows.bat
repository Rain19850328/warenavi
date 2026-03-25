@echo off
REM Windows 실행 스크립트 (Light Theme)
REM set ITEMS_DB_URL=mysql+pymysql://USER:PASS@PC_IP:3306/items
uvicorn app.main:app --host 0.0.0.0 --port 8000
