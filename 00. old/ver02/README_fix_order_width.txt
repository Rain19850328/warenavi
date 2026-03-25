# Fix: 1층 아래/3층 위 + 번호/렉 너비 정렬
이 패치는 다음을 해결합니다.
1) **층 순서 뒤집기**: 3층이 위, 1층이 아래에 오도록 렌더 순서를 변경
2) **열 라벨과 셀 너비 정렬**: 베이 번호(열 라벨)와 셀의 폭을 같은 변수로 맞춤
3) **1px 드리프트 방지**: `box-sizing: border-box` 적용

## 적용 방법
1) `web/app.js`를 교체하세요.
2) `web/style.css` 맨 아래에 `style_fix_order_width.css` 내용을 **붙여넣기** 하거나,
   아래 한 줄을 style.css 마지막에 추가:
   ```css
   @import "./style_fix_order_width.css";
   ```
3) 브라우저 강력 새로고침 또는 Service Worker Unregister 후 새로고침.

## 필요시 조정
- 셀/라벨 공통 폭: `--cell-w`
- 축 라벨 폭: `--axis-w`
- 모바일 기준폭, 글자 크기 등은 미디어쿼리에서 조정 가능
