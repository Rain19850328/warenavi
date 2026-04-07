-- items 테이블에 image_url 컬럼 추가 (MOPS 2026 ORM 모델과 호환)
alter table public.items add column if not exists image_url text;
