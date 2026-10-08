// scan.js — 사진으로 코드 읽기 (window.Scan)
// 폰 기본 카메라로 찍은 사진을 줄여서 서버(/scan_code)에 보내고, 서버가 읽어 DB와 대조한 코드 후보를 받는다.
// 글자 인식은 서버에서 하므로 이 파일에는 인식 라이브러리가 없다.
(function () {
  'use strict';

  const MAX_SIDE = 1568;      // 긴 변 기준 축소 크기(px). 기울어진 작은 글자도 읽히도록 인식 모델이 받는 최대 크기에 맞춘다
  const JPEG_QUALITY = 0.85;
  const MAX_ATTEMPTS = 3;     // 못 찾으면 사진을 돌려 다시 읽는 횟수 포함
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

  // 긴 변 MAX_SIDE 이하의 JPEG로 줄여 base64로 돌려준다. rotate(0/90/180/270)만큼 시계 방향으로 돌려서 그린다.
  async function shrink(file, rotate) {
    const source = await decode(file);
    const sw = source.width || source.naturalWidth;
    const sh = source.height || source.naturalHeight;
    if (!sw || !sh) throw new Error('사진을 열지 못했습니다.');
    const angle = [90, 180, 270].includes(Number(rotate)) ? Number(rotate) : 0;
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    const sideways = angle === 90 || angle === 270;
    const canvas = document.createElement('canvas');
    canvas.width = sideways ? dh : dw;
    canvas.height = sideways ? dw : dh;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';   // 투명 배경(PNG)이 검게 나오지 않도록
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(angle * Math.PI / 180);
    ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
    if (typeof source.close === 'function') source.close();
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const comma = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:image/jpeg') || comma < 0) throw new Error('사진을 변환하지 못했습니다.');
    return { media_type: 'image/jpeg', image_base64: dataUrl.slice(comma + 1), width: canvas.width, height: canvas.height };
  }

  const hasCodes = res => !!(res && Array.isArray(res.candidates) && res.candidates.length);

  // 사진 한 장을 읽는다. DB에 있는 코드를 못 찾으면 서버가 알려준 방향(rotate)대로 돌려서 다시 읽는다.
  // 글자가 거꾸로이거나 옆으로 누운 라벨을 위한 것으로, 방향 힌트가 없으면 180도(거꾸로)를 한 번 시도한다.
  async function readPhoto(file) {
    let angle = 0;
    const tried = [];
    const raw = [];
    let last = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      tried.push(angle);
      const image = await api.shrink(file, angle);
      last = await UI.api.post('/scan_code', { image_base64: image.image_base64, media_type: image.media_type });
      for (const text of (last && Array.isArray(last.raw) ? last.raw : [])) if (text && !raw.includes(text)) raw.push(text);
      if (hasCodes(last)) break;
      const hint = [90, 180, 270].includes(Number(last && last.rotate)) ? Number(last.rotate) : 0;
      let next = (angle + hint) % 360;
      if (tried.includes(next)) next = [180, 90, 270].find(a => !tried.includes(a));
      if (next === undefined || attempt + 1 >= MAX_ATTEMPTS) break;
      angle = next;
    }
    return Object.assign({}, last, { raw, attempts: tried.length });
  }

  // 촬영 → 축소 → 서버 인식. 결과 {candidates, raw}, 취소했거나 실패하면 undefined(실패는 화면에 알린다).
  async function recognize(button) {
    const file = await api.pick();
    if (!file) return undefined;
    return UI.busy(button, async () => {
      try {
        return await readPhoto(file);
      } catch (err) {
        if (!err || err.code !== 'AUTH_REQUIRED') notify(button, (err && err.message) || '사진을 읽지 못했습니다.');
        return undefined;
      }
    });
  }

  // 팝업 창(모달) 안에서는 토스트가 창 뒤에 가려지므로 알림창으로 알린다.
  function notify(button, message) {
    if (button && button.closest && button.closest('dialog[open]')) window.alert(message);
    else UI.toast(message, 'error');
  }

  /* ---------- 읽은 코드를 검색칸에 넣기 (어느 화면에서나 공용) ---------- */
  let chooser = null;

  // 코드가 여러 개 읽혔을 때 하나를 고르게 한다. 취소하면 null.
  function choose(candidates) {
    if (!chooser || !chooser.isConnected) {
      chooser = document.createElement('dialog');
      chooser.className = 'scan-choose';
      document.body.append(chooser);
    }
    if (typeof chooser.showModal !== 'function') return Promise.resolve(candidates[0] || null);
    chooser.innerHTML = `
      <form method="dialog" class="dialog">
        <h3>사진에서 읽은 코드</h3>
        <div class="scan-choose__list">
          ${candidates.map((c, i) => `<button type="submit" value="${i}">${c.kind === 'rack' ? '랙 ' : ''}${UI.esc(c.text)}${
            c.kind !== 'rack' && Array.isArray(c.matches) && c.matches.length === 1 && c.matches[0].name
              ? `<small>${UI.esc(c.matches[0].name)}</small>` : ''}</button>`).join('')}
        </div>
        <div class="row"><span></span><button type="submit" value="">취소</button></div>
      </form>`;
    return new Promise(resolve => {
      const form = chooser.querySelector('form');
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        if (chooser.open) chooser.close();
        resolve(value);
      };
      // 누른 버튼의 value가 고른 순번이다(취소는 빈 값).
      form.addEventListener('submit', ev => {
        ev.preventDefault();
        const idx = ev.submitter ? ev.submitter.value : '';
        finish(idx === '' ? null : (candidates[Number(idx)] || null));
      });
      chooser.addEventListener('close', () => finish(null), { once: true });   // Esc 등으로 닫힌 경우
      chooser.showModal();
    });
  }

  // 검색칸에 넣을 글자: 상품이 하나로 정해졌으면 그 상품 코드, 아니면 읽은 글자 그대로.
  function textOf(candidate) {
    const matches = Array.isArray(candidate.matches) ? candidate.matches : [];
    return candidate.kind !== 'rack' && matches.length === 1 && matches[0].code ? matches[0].code : candidate.text;
  }

  // 촬영 → 인식 → (여러 개면 선택) → input에 넣고 input 이벤트를 낸다. 넣은 글자를 돌려준다(없으면 '').
  async function fill(button, input) {
    if (!input) return '';
    const res = await api.recognize(button);
    if (!res) return '';
    const candidates = Array.isArray(res.candidates) ? res.candidates.filter(c => c && c.text) : [];
    if (!candidates.length) {
      const raw = Array.isArray(res.raw) ? res.raw.filter(Boolean).slice(0, 4).join(', ') : '';
      notify(button, `코드를 찾지 못했습니다. 라벨을 가까이서 다시 찍어주세요${raw ? ` (읽은 글자: ${raw})` : ''}`);
      return '';
    }
    const picked = candidates.length === 1 ? candidates[0] : await api.choose(candidates);
    if (!picked) return '';
    const text = textOf(picked);
    input.value = text;
    // 입력 이벤트로 목록 필터·지우기 버튼 등을 갱신한다. 자동완성이 뒤늦게 열리는 칸은 data-scan-quiet 로 끈다.
    if (!button || button.dataset.scanQuiet === undefined) input.dispatchEvent(new Event('input', { bubbles: true }));
    return text;
  }

  // 마크업만으로 연결: <button data-scan-for="#입력칸" data-scan-then="submit | #누를버튼">
  document.addEventListener('click', async ev => {
    const button = ev.target.closest && ev.target.closest('[data-scan-for]');
    if (!button) return;
    ev.preventDefault();
    const scope = button.closest('form, dialog, header, .view') || document;
    const find = sel => (sel ? scope.querySelector(sel) || document.querySelector(sel) : null);
    const input = find(button.dataset.scanFor);
    const text = await fill(button, input);
    if (!text) return;
    const then = button.dataset.scanThen;
    if (then === 'submit') {
      if (input.form && typeof input.form.requestSubmit === 'function') input.form.requestSubmit();
    } else if (then) {
      const target = find(then);
      if (target) target.click();
    }
  });

  const api = { pick, shrink, recognize, choose, fill };   // readPhoto 가 api.shrink 를 거치므로 시험에서 바꿔 끼울 수 있다
  window.Scan = api;
})();
