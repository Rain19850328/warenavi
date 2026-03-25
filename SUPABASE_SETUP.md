# Supabase Backend Setup

이 저장소에는 Supabase용 백엔드 골격이 추가되어 있습니다.

구성:
- `supabase/migrations/20260325180000_init_warehouse.sql`: 창고 데이터 스키마와 RPC 함수
- `supabase/functions/warehouse-api/index.ts`: 기존 FastAPI 계약을 흉내 내는 HTTP Edge Function
- `.github/workflows/deploy-supabase.yml`: `main` 푸시 시 마이그레이션과 Edge Function 자동 배포

## GitHub에 추가해야 할 값

Repository secrets:
- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`

Repository variables:
- `SUPABASE_PROJECT_REF`
- `PUBLIC_SITE_ORIGIN`
- `PUBLIC_API_BASE`

권장 값:
- `SUPABASE_PROJECT_REF`: Supabase 대시보드 URL의 프로젝트 ref
- `PUBLIC_SITE_ORIGIN`: Cloudflare Pages 프론트 주소
  예: `https://warenavi.pages.dev`
- `PUBLIC_API_BASE`: Supabase Edge Function 기본 주소
  예: `https://<project-ref>.supabase.co/functions/v1/warehouse-api`

## 배포 흐름

1. `main` 브랜치에 `supabase/**` 변경사항을 push합니다.
2. GitHub Actions가 Supabase CLI로 프로젝트를 link 합니다.
3. `supabase/migrations`의 SQL을 원격 Postgres에 적용합니다.
4. `warehouse-api` Edge Function을 배포합니다.
5. 프론트 Cloudflare Pages 워크플로는 `PUBLIC_API_BASE`를 읽어 `web/config.js`를 생성하고 배포합니다.

## 현재 구조에서 바뀌는 점

기존:
- 프론트 `web/app.js`가 같은 서버의 `/api`를 호출
- 백엔드는 `app/main.py` FastAPI + MySQL

변경 후:
- 프론트는 `web/config.js`의 `API_BASE`를 호출
- 백엔드는 Supabase Edge Function이 HTTP `/config`, `/cells`, `/items`, `/items_with_stock`, `/search_racks`, `/inbound`, `/outbound`, `/move`, `/set_location`를 처리
- 실데이터는 Supabase Postgres 테이블 `warehouse_items`, `warehouse_racks`, `daily_stock`를 사용

## 남은 수동 작업

1. 기존 MySQL 데이터를 Supabase Postgres로 옮겨야 합니다.
2. `daily_stock.date` 컬럼 이름이 현재 SQL에서는 `stock_date`로 바뀌었으므로 마이그레이션 시 매핑이 필요합니다.
3. 현재 Edge Function은 `verify_jwt = false`로 되어 있습니다.
   운영에서는 로그인/권한 정책을 넣고 다시 잠그는 것이 맞습니다.
4. Cloudflare Pages가 새 `PUBLIC_API_BASE` 값을 읽도록 다시 한 번 push 해야 합니다.

## 데이터 이전 권장 순서

1. Supabase 프로젝트 생성
2. GitHub secrets / vars 입력
3. 빈 프로젝트에 이 저장소 push
4. Actions가 스키마를 생성한 뒤
5. MySQL 데이터를 `warehouse_items`, `warehouse_racks`, `daily_stock`로 이관
6. 프론트에서 실제 조회/입출고/이동 테스트
