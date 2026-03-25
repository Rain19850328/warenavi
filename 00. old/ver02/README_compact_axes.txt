# Compact Axis Patch
이 패치는 휴대폰에서도 한눈에 보기 쉽게 **박스 크기를 최소화**하고, **가로(칸)·세로(층) 좌표 라벨**을 추가합니다.
- 셀 내부엔 **적재율(%)만 중앙 표시**합니다.

## 적용 방법
1) 프로젝트의 `web/app.js`를 이 패키지의 파일로 **교체**합니다.
2) `web/style.css` 맨 아래에 `style_append_compact_axes.css` 내용을 **그대로 붙여넣기**(append) 하거나,
   파일을 그대로 두고 `@import "./style_append_compact_axes.css";` 를 style.css의 마지막 줄에 추가하세요.

### @import 예시
```css
@import "./style_append_compact_axes.css";
```

3) 브라우저 **강력 새로고침** (Ctrl+F5 / Shift+Reload) 또는 Service Worker Unregister 후 새로고침.

## 되돌리기
- `app.js`를 이전 버전으로 복원하고, style.css에 추가했던 내용/임포트를 제거하면 됩니다.
