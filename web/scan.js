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

  // 촬영 → 축소 → 서버 인식. 결과 {candidates, raw}, 취소했거나 실패하면 undefined(실패는 화면에 알린다).
  async function recognize(button) {
    const file = await api.pick();
    if (!file) return undefined;
    return UI.busy(button, async () => {
      try {
        const image = await api.shrink(file);
        return await UI.api.post('/scan_code', { image_base64: image.image_base64, media_type: image.media_type });
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

  const api = { pick, shrink, recognize, choose, fill };
  window.Scan = api;
})();
