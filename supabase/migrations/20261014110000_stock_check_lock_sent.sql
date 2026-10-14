-- 플레이오토로 전송을 마친 재고확인 건은 되돌릴 수 없게 한다.
--   재고확인 탭의 처리취소 · 다시 확인 · 수량 수정은 확인요청 판단과 전송 표시를 지우므로,
--   전송 완료(playauto_status = 'sent')인 줄에서는 거절한다. 다시 보내면 플레이오토 재고가 두 번 바뀐다.
create or replace function public.warehouse_stock_check_clear_review()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'mismatch'
     or new.counted_qty is distinct from old.counted_qty
     or (old.resolved and not new.resolved and new.review_status in ('applied', 'rejected')) then
    if old.playauto_status = 'sent' then
      raise exception '플레이오토로 전송 완료된 건은 되돌릴 수 없습니다';
    end if;
    new.review_status := '';
    new.review_note := '';
    new.reviewed_at := null;
    new.reviewed_by_user_id := null;
    new.reviewed_by_name := '';
    new.playauto_status := '';
    new.playauto_sent_at := null;
    new.playauto_message := '';
  end if;
  return new;
end;
$$;
