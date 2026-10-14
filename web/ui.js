// ui.js — 탭 화면 공용 UI 키트 (window.UI)
// app.js 전역(API_BASE, getJSON, postJSON, todayYmd)은 호출 시점에 찾는다 → app.js보다 먼저 로드돼도 안전.
(function () {
  'use strict';

  const CHIP_TONES = ['ok', 'warn', 'danger', 'info', 'muted'];
  const TOAST_TONES = ['info', 'ok', 'error'];
  const GENERIC_ERROR = '요청에 실패했습니다.';

  /* ---------- formatters ---------- */
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`]/g, ch => ESC_MAP[ch]);
  }

  function num(value) {
    if (value === null || value === undefined || value === '') return '-';
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    return n.toLocaleString('ko-KR');
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${pad2(d.getFullYear() % 100)}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function localYmd(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function today() {
    try { if (typeof todayYmd === 'function') return todayYmd(); } catch (_) {}
    return localYmd(new Date());
  }
  function isYmd(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  /* ---------- toast ---------- */
  let toastHost = null;
  function ensureToastHost() {
    if (toastHost && toastHost.isConnected) return toastHost;
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('aria-live', 'polite');
    toastHost.setAttribute('role', 'status');
    // popover(최상위 레이어)로 띄워야 열려 있는 <dialog> 위에서도 보인다. 미지원 브라우저는 일반 fixed.
    if (typeof toastHost.showPopover === 'function') toastHost.setAttribute('popover', 'manual');
    document.body.append(toastHost);
    return toastHost;
  }
  function raiseToastHost(host) {
    if (typeof host.showPopover !== 'function') return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch (_) {}
  }

  function toast(message, tone = 'info') {
    const text = String(message ?? '').trim();
    if (!text) return;
    const kind = TOAST_TONES.includes(tone) ? tone : 'info';
    const host = ensureToastHost();
    const el = document.createElement('div');
    el.className = `toast toast--${kind}`;
    el.textContent = text;
    host.append(el);
    while (host.children.length > 4) host.firstElementChild.remove();
    raiseToastHost(host);

    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      el.classList.add('is-leaving');
      setTimeout(() => {
        el.remove();
        if (!host.children.length && typeof host.hidePopover === 'function') {
          try { if (host.matches(':popover-open')) host.hidePopover(); } catch (_) {}
        }
      }, 200);
    };
    el.addEventListener('click', dismiss);
    setTimeout(dismiss, kind === 'error' ? 4000 : 2500);
  }

  /* ---------- confirm ---------- */
  function confirmDialog(message) {
    const text = String(message ?? '');
    const probe = document.createElement('dialog');
    if (typeof probe.showModal !== 'function') {
      return Promise.resolve(window.confirm(text));
    }
    return new Promise(resolve => {
      const dlg = probe;
      dlg.className = 'ui-confirm';
      dlg.innerHTML = `
        <div class="ui-confirm__body"></div>
        <div class="ui-confirm__actions">
          <button type="button" class="btn-ghost" data-act="cancel">취소</button>
          <button type="button" class="btn-primary" data-act="ok">확인</button>
        </div>`;
      dlg.querySelector('.ui-confirm__body').textContent = text;
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        try { if (dlg.open) dlg.close(); } catch (_) {}
        dlg.remove();
        resolve(result);
      };
      dlg.querySelector('[data-act="ok"]').addEventListener('click', () => finish(true));
      dlg.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
      // 바깥(backdrop) 클릭 / Esc = 취소
      dlg.addEventListener('click', ev => { if (ev.target === dlg) finish(false); });
      dlg.addEventListener('cancel', () => finish(false));
      dlg.addEventListener('close', () => finish(false));
      document.body.append(dlg);
      dlg.showModal();
      dlg.querySelector('[data-act="ok"]').focus();
    });
  }

  /* ---------- chips ---------- */
  function chip(text, tone = 'muted') {
    const kind = CHIP_TONES.includes(tone) ? tone : 'muted';
    return `<span class="chip chip--${kind}">${esc(text)}</span>`;
  }

  // SR2는 수량을 세지 않는 렉이다. 숫자는 의미가 없고 '있음/없음'만 본다.
  function isPresenceRack(rackCode) {
    return /^SR2-/i.test(String(rackCode || '').trim());
  }

  // 렉 코드 입력 도우미(상품조회·재고확인의 입고 칸이 함께 쓴다).
  //   구역(SR1/SR2 …)은 선택 상자로 고르고, 옆 칸에는 뒤쪽만 친다. 숫자는 두 자리마다 '-'를 넣는다(0502 → 05-02).
  //   SR2의 정식 표기는 글자-숫자(SR2-A-01)라서 A~F 글자로 시작하는 뒤쪽은 그대로 살린다.
  //   사진으로 읽었거나 붙여 넣은 전체 코드(SR3-10-01, SR-02-A-01)는 구역과 뒤쪽으로 나눈다.
  const RACK_ZONES = ['SR1', 'SR2'];
  function splitRackCode(value) {
    const v = String(value || '').toUpperCase().replace(/\s+/g, '');
    const m = /^SR-?(\d{1,2})(?:-(.*))?$/.exec(v);
    const zone = m ? `SR${Number(m[1])}` : '';
    const raw = m ? (m[2] || '') : v;
    const letter = /^[A-F]/.test(raw) ? raw[0] : '';
    const digits = raw.replace(/\D/g, '').slice(0, 4);
    const rest = letter
      ? (digits ? `${letter}-${digits.slice(0, 2)}` : letter)
      : (digits.match(/\d{1,2}/g) || []).join('-');
    return { zone, rest };
  }
  // 입력 칸(form.elements.zone / .rack)에 값을 나눠 넣는다. 선택 상자에 없는 구역이면 항목을 추가한다.
  function applyRackCode(form, value) {
    const parts = splitRackCode(value);
    const select = form.elements.zone;
    if (parts.zone && select) {
      if (!Array.from(select.options).some(o => o.value === parts.zone)) select.add(new Option(parts.zone, parts.zone));
      select.value = parts.zone;
    }
    if (form.elements.rack.value !== parts.rest) form.elements.rack.value = parts.rest;
    return parts;
  }
  // 입력 칸에서 전체 렉 코드를 읽는다. 뒤쪽을 끝까지 적지 않았으면 ''.
  function readRackCode(form) {
    const rest = splitRackCode(form.elements.rack.value).rest;
    return /^(\d{2}-\d{2}|[A-F]-\d{2})$/.test(rest) ? `${form.elements.zone.value}-${rest}` : '';
  }

  function rackChips(racks) {
    const list = Array.isArray(racks) ? racks.filter(r => r && r.rack_code) : [];
    if (!list.length) return chip('스토리지렉 재고 없음', 'muted');
    return `<span class="rack-chips">${list.map(r => chip(`${r.rack_code} · ${isPresenceRack(r.rack_code) ? '있음' : num(r.qty)}`, 'info')).join('')}</span>`;
  }

  /* ---------- date bar ---------- */
  // set(ymd)는 화면 값만 바꾸고 onChange는 부르지 않는다(사용자 조작일 때만 호출).
  // allowAll: '전체' 버튼을 함께 보여 준다. 이때 값 ''는 "날짜 전체"를 뜻한다.
  function dateBar(container, { value, onChange, allowAll = false } = {}) {
    let current = isYmd(value) ? value : (allowAll ? '' : today());
    const wrap = document.createElement('div');
    wrap.className = 'date-bar';
    // 탭 제목 오른쪽에 들어가는 작은 날짜칸. '오늘' 버튼은 다른 날짜를 보고 있을 때만 나온다.
    wrap.innerHTML = `
      ${allowAll
        ? '<button type="button" class="btn-sm date-bar__all" data-act="all">전체</button>'
        : '<button type="button" class="btn-sm date-bar__today" data-act="today" hidden>오늘</button>'}
      <input type="date" class="date-bar__input" aria-label="날짜" />`;
    const input = wrap.querySelector('input');
    const todayBtn = wrap.querySelector('[data-act="today"]');
    const allBtn = wrap.querySelector('[data-act="all"]');
    const valid = v => isYmd(v) || (allowAll && v === '');
    const sync = () => {
      input.value = current;
      if (todayBtn) todayBtn.hidden = current === today();
      if (allBtn) {
        allBtn.classList.toggle('is-active', current === '');
        allBtn.setAttribute('aria-pressed', current === '' ? 'true' : 'false');
      }
    };
    sync();

    const commit = next => {
      if (!valid(next)) { sync(); return; }
      const changed = next !== current;
      current = next;
      sync();
      if (changed && typeof onChange === 'function') onChange(current);
    };
    input.addEventListener('change', () => commit(input.value));
    if (todayBtn) todayBtn.addEventListener('click', () => commit(today()));
    if (allBtn) allBtn.addEventListener('click', () => commit(''));

    if (container) container.append(wrap);
    return {
      get: () => current,
      set: ymd => { if (valid(ymd)) { current = ymd; sync(); } },
    };
  }

  /* ---------- busy ---------- */
  async function busy(button, asyncFn) {
    if (button && button.dataset.busy === '1') return undefined;
    const wasDisabled = button ? button.disabled : false;
    if (button) {
      button.dataset.busy = '1';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    }
    try {
      return await asyncFn();
    } catch (err) {
      // 인증 만료는 로그인 화면이 이미 떠 있으므로 토스트를 띄우지 않는다.
      if (err?.code !== 'AUTH_REQUIRED') toast(err?.message || GENERIC_ERROR, 'error');
      return undefined;
    } finally {
      if (button) {
        delete button.dataset.busy;
        button.removeAttribute('aria-busy');
        button.disabled = wasDisabled;
      }
    }
  }

  /* ---------- api ---------- */
  // '{"detail":"{\"code\":\"P0001\",\"message\":\"…\"}"}' 처럼 겹겹이 싸인 오류에서 사람이 읽을 문장만 꺼낸다.
  function cleanMessage(raw) {
    let cur = raw;
    for (let depth = 0; depth < 6; depth++) {
      if (cur === null || cur === undefined) break;
      if (typeof cur === 'object') {
        if (Array.isArray(cur)) { cur = cur[0]; continue; }
        const next = cur.detail ?? cur.message ?? cur.msg ?? cur.error_description ?? cur.error ?? cur.hint;
        if (next === undefined || next === null) break;
        cur = next;
        continue;
      }
      const text = String(cur).trim();
      if (!text) break;
      if (/^[{["]/.test(text)) {
        try { cur = JSON.parse(text); continue; } catch (_) {}
      }
      if (/^<!doctype|^<html/i.test(text) || text === '[object Object]') return GENERIC_ERROR;
      if (/^(Failed to fetch|NetworkError|Load failed)/i.test(text)) return '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.';
      return text;
    }
    return GENERIC_ERROR;
  }

  function normalizeError(err) {
    if (err && err.code === 'AUTH_REQUIRED') return err;
    const out = new Error(cleanMessage(err && err.message !== undefined ? err.message : err));
    out.cause = err;
    return out;
  }

  function apiBase() {
    try { if (typeof API_BASE === 'string') return API_BASE; } catch (_) {}
    return (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || '/api';
  }

  function buildUrl(path, params) {
    const qs = new URLSearchParams();
    if (params && typeof params === 'object') {
      for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined || value === '') continue;
        qs.append(key, String(value));
      }
    }
    const query = qs.toString();
    const cleanPath = String(path || '').startsWith('/') ? path : `/${path}`;
    return `${apiBase()}${cleanPath}${query ? (cleanPath.includes('?') ? '&' : '?') + query : ''}`;
  }

  async function apiGet(path, params) {
    try {
      return await getJSON(buildUrl(path, params));
    } catch (err) {
      throw normalizeError(err);
    }
  }

  async function apiPost(path, body) {
    try {
      return await postJSON(buildUrl(path), body === undefined || body === null ? {} : body);
    } catch (err) {
      throw normalizeError(err);
    }
  }

  window.UI = {
    esc,
    num,
    fmtDateTime,
    toast,
    confirm: confirmDialog,
    chip,
    isPresenceRack,
    rackChips,
    rackCode: { zones: RACK_ZONES, split: splitRackCode, apply: applyRackCode, read: readRackCode },
    dateBar,
    busy,
    api: { get: apiGet, post: apiPost },
  };
})();
