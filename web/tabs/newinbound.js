// tabs/newinbound.js — 신규입고 탭
// 목록·진열·입고 처리는 app.js(openNewInboundDialog 등)가 그대로 맡고, 여기서는 탭 화면에 연결만 한다.
(function () {
  'use strict';

  function onShow() {
    try {
      if (typeof openNewInboundDialog !== 'function') throw new Error('신규입고 화면을 불러오지 못했습니다.');
      Promise.resolve(openNewInboundDialog()).catch(err => alert('신규입고리스트 오류: ' + (err.message || err)));
    } catch (err) {
      alert('신규입고리스트 오류: ' + (err.message || err));
    }
  }

  Shell.register({ id: 'newinbound', label: '신규입고', mount(root) { root.classList.add('tab-newinbound'); }, onShow, onHide() {} });
})();
