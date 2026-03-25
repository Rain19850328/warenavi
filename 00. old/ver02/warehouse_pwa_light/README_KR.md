# 창고 현황판 PWA (라이트 테마)

## 설치
```bash
cd warehouse_pwa_light
pip install -r requirements.txt
```

(선택) MySQL 사용 시 환경변수 `ITEMS_DB_URL` 설정. 미설정 시 샘플데이터로 동작.

## 실행
- Windows: `run_windows.bat` 또는 `uvicorn app.main:app --host 0.0.0.0 --port 8000`
- macOS/Linux: `./run_linux_mac.sh`

## 접속
- PC: http://127.0.0.1:8000/web/
- 태블릿(동일 Wi-Fi): http://<PC_IP>:8000/web/

## 참고
- 라이트 팔레트 적용, 셀 색상/범례도 밝은 톤
- 서비스워커 캐시 v20 → 새로고침만으로 최신 반영 (안 되면 강력 새로고침 또는 Service Worker Unregister)
