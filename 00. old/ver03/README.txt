
# Warehouse PWA (선택 글로우 강조, 새 경로 반영)

새 루트 경로: **D:\02. program\warehouse_service** 에 맞춰 Caddy 설정을 포함했습니다.

## 구성
- `web/` : PWA 정적 파일
- `Caddyfile` : 도메인 운영용 (sellingonwarehouse.store, HTTPS 자동)
- `Caddyfile.local` : 로컬 테스트용 (http://localhost/web/)
- `README.txt` : 이 안내

## 실행 (백엔드 FastAPI는 /api 제공 가정)
1) `web/` 폴더를 `D:\02. program\warehouse_service\web` 에 둡니다.
2) (PowerShell #1) 백엔드 실행
   ```powershell
   cd "D:\02. program\warehouse_service"
   py -m uvicorn app.main:app --host 127.0.0.1 --port 8000
   ```
3) (PowerShell #2) Caddy 실행
   - **도메인 운영**
     ```powershell
     cd C:\caddy
     .\caddy.exe validate --config "C:\(압축해제경로)\Caddyfile"
     .\caddy.exe run --config "C:\(압축해제경로)\Caddyfile" --watch
     ```
   - **로컬 테스트**
     ```powershell
     cd C:\caddy
     .\caddy.exe run --config "C:\(압축해제경로)\Caddyfile.local" --watch
     ```

## 접속
- 로컬: http://localhost/web/
- 도메인: https://sellingonwarehouse.store/web/

## 캐시가 남아 예전 화면이면
- 강력 새로고침(Ctrl+F5) 또는 DevTools → Application → Service Workers → Unregister 후 새로고침
- `web/sw.js` 의 `CACHE` 문자열을 변경해도 됩니다.

