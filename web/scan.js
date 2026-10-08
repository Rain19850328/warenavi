// scan.js — 사진으로 코드 읽기 (window.Scan)
// 폰 기본 카메라로 찍은 사진을 줄여서 서버(/scan_code)에 보내고, 서버가 읽어 DB와 대조한 코드 후보를 받는다.
// 글자 인식은 서버에서 하므로 이 파일에는 인식 라이브러리가 없다.
(function () {
  'use strict';

  const MAX_SIDE = 1280;      // 긴 변 기준 축소 크기(px)
  const JPEG_QUALITY = 0.8;
  const PICK_IDLE_MS = 800;   // 카메라에서 돌아온 뒤 이 시간 안에 사진이 없으면 취소로 본다

  let picker = null;

  function ensurePicker() {
    if (picker && picker.isConnected) return picker;
    picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.setAttribute('capture', 'environment');   // 후면 카메라
    picker.hidden = true;
    picker.tabIndex = -1;
    picker.setAttribute('aria-hidden', 'true');
    document.body.append(picker);
    return picker;
  }

  // 카메라(또는 사진 선택)를 열고 고른 파일을 돌려준다. 취소하면 null.
  function pick() {
    const input = ensurePicker();
    input.value = '';
    return new Promise(resolve => {
      let settled = false;
      let idleTimer = null;
      const finish = file => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        input.removeEventListener('change', onChange);
        input.removeEventListener('cancel', onCancel);
        window.removeEventListener('focus', onFocus);
        resolve(file || null);
      };
      const onChange = () => finish(input.files && input.files[0]);
      const onCancel = () => finish(null);
      // cancel 이벤트가 없는 브라우저: 화면으로 돌아왔는데 파일이 없으면 취소로 본다
      const onFocus = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(input.files && input.files[0]), PICK_IDLE_MS);
      };
      input.addEventListener('change', onChange);
      input.addEventListener('cancel', onCancel);
      window.addEventListener('focus', onFocus);
      input.click();
    });
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 열지 못했습니다.')); };
      img.src = url;
    });
  }

  async function decode(file) {
    if (typeof createImageBitmap === 'function') {
      // 폰을 세워 찍은 사진이 눕지 않도록 촬영 방향을 반영한다
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) {}
    }
    return loadImage(file);
  }

  // 긴 변 MAX_SIDE 이하의 JPEG로 줄여 base64로 돌려준다.
  async function shrink(file) {
    const source = await decode(file);
    const sw = source.width || source.naturalWidth;
    const sh = source.height || source.naturalHeight;
    if (!sw || !sh) throw new Error('사진을 열지 못했습니다.');
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';   // 투명 배경(PNG)이 검게 나오지 않도록
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (typeof source.close === 'function') source.close();
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const comma = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:image/jpeg') || comma < 0) throw new Error('사진을 변환하지 못했습니다.');
    return { media_type: 'image/jpeg', image_base64: dataUrl.slice(comma + 1), width: canvas.width, height: canvas.height };
  }

  // 촬영 → 축소 → 서버 인식. 결과 {candidates, raw}, 취소했거나 실패하면 undefined(실패는 토스트로 알린다).
  async function recognize(button) {
    const file = await api.pick();
    if (!file) return undefined;
    return UI.busy(button, async () => {
      const image = await api.shrink(file);
      return UI.api.post('/scan_code', { image_base64: image.image_base64, media_type: image.media_type });
    });
  }

  const api = { pick, shrink, recognize };
  window.Scan = api;
})();
