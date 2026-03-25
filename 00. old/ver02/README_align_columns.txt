# Fix: Column label alignment with rack columns
이 패치는 가로축 라벨(베이 번호)이 아래 랙 칸과 **완전히 동일한 열**에 오도록 맞춥니다.

핵심 아이디어
- Header(라벨)와 Grid(칸)를 **동일한 가로 스크롤 컨테이너(.scrollX)** 안에 넣어 함께 스크롤
- 라벨(.colLabel)과 컬럼(.bay)에 **동일한 너비와 flex-basis**를 지정해서 수축/확장 금지
- Header와 Grid 모두 `min-width: max-content`로 감싸 실제 총너비로 고정

## 적용 방법
1) `web/app.js`를 본 패키지의 파일로 교체
2) `web/style.css`를 본 패키지의 파일로 교체 **또는** 아래 클래스들을 기존 CSS에 추가/수정
3) 브라우저 강력 새로고침 또는 Service Worker Unregister 후 새로고침

## 조정 가능 변수
- `--cell-w`: 각 베이/라벨의 공통 너비
- `--axis-w`: 좌측 층 라벨 폭
- 미디어쿼리에서 모바일 값 별도 지정
