/* StockSync 화면 보조 스크립트 (CSP 때문에 인라인 스크립트를 쓰지 않는다) */
(function () {
  'use strict';

  // 스캔 입력창은 항상 포커스: 스캐너는 키보드처럼 입력하고 Enter 를 보낸다.
  var scan = document.querySelector('[data-scan-input]');
  if (scan) {
    scan.focus();
    scan.select();
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && /^(INPUT|SELECT|TEXTAREA|BUTTON|A|LABEL)$/.test(t.tagName)) return;
      scan.focus();
    });
  }

  // 결과 알림음 (성공/실패를 눈으로 안 봐도 알 수 있게)
  var beep = document.body.getAttribute('data-beep');
  if (beep && scan) {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.frequency.value = beep === 'err' ? 180 : 880;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (beep === 'err' ? 0.35 : 0.08));
    } catch (e) { /* 소리가 막혀 있어도 동작에는 영향 없음 */ }
  }

  // 목록 개수: 폰(640px 이하)은 10개, 그 밖은 20개. 서버가 추정한 개수가 실제 화면 폭과 다르면 쿠키를 고치고 한 번만 다시 불러온다.
  var mq = window.matchMedia('(max-width: 640px)');
  function deviceCookie() { return mq.matches ? 'm' : 'd'; }
  function setDevice() { document.cookie = 'dv=' + deviceCookie() + '; Path=/; Max-Age=31536000; SameSite=Lax'; }
  var servedSize = Number(document.body.getAttribute('data-ps') || 0);
  if (servedSize) {
    var want = mq.matches ? 10 : 20;
    setDevice();
    if (servedSize !== want && document.querySelector('.pager, .table-wrap table.stack') && !/[?&]dv=/.test(location.search)) {
      var url = new URL(location.href);
      url.searchParams.set('dv', '1');
      location.replace(url.toString());
    }
  }
  if (mq.addEventListener) mq.addEventListener('change', setDevice);


  // 대시보드 타일: 커서를 따라 은은한 빛이 움직인다 (마우스일 때만)
  document.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse') return;
    var t = e.target && e.target.closest && e.target.closest('a.stat');
    if (!t) return;
    var r = t.getBoundingClientRect();
    t.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    t.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });

  // 화면 테마: 라이트 / 다크 / 시스템. 쿠키에 저장해 서버가 다음 화면부터 바로 적용한다(깜빡임 없음).
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-theme-set]');
    if (!b) return;
    var v = b.getAttribute('data-theme-set');
    var root = document.documentElement;
    if (v === 'system') {
      document.cookie = 'theme=; Path=/; Max-Age=0; SameSite=Lax';
      root.removeAttribute('data-theme');
    } else {
      document.cookie = 'theme=' + v + '; Path=/; Max-Age=31536000; SameSite=Lax';
      root.setAttribute('data-theme', v);
    }
    document.querySelectorAll('[data-theme-set]').forEach(function (x) {
      x.setAttribute('aria-pressed', x.getAttribute('data-theme-set') === v ? 'true' : 'false');
    });
  });

  // 체크박스 선택 → 일괄 처리 (form[data-select]): 선택 개수에 맞춰 버튼을 켜고 확인 문구를 갱신한다.
  document.querySelectorAll('form[data-select]').forEach(function (form) {
    var id = form.id;
    var boxes = function () { return Array.prototype.slice.call(document.querySelectorAll('input[name=ids][form=' + id + ']:not(:disabled)')); };
    var countEl = form.querySelector('[data-sel-count]');
    var goBtns = form.querySelectorAll('[data-needs-selection]');
    var tpl = form.getAttribute('data-confirm-tpl') || '';
    var all = form.querySelector('[data-check-all]');
    var refresh = function () {
      var list = boxes();
      var n = list.filter(function (c) { return c.checked; }).length;
      if (countEl) countEl.textContent = String(n);
      goBtns.forEach(function (b) { b.disabled = n === 0; });
      if (tpl) form.setAttribute('data-confirm', tpl.replace('{n}', String(n)));
      if (all) { all.checked = n > 0 && n === list.length; all.indeterminate = n > 0 && n < list.length; }
      return n;
    };
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t === all) { boxes().forEach(function (c) { c.checked = all.checked; }); refresh(); }
      else if (t && t.name === 'ids' && t.getAttribute('form') === id) refresh();
    });
    // 버튼마다 확인 문구가 다른 경우: 누르는 순간 선택 개수를 넣는다
    form.addEventListener('click', function (e) {
      var b = e.target && e.target.closest && e.target.closest('[data-confirm-tpl]');
      if (b && b !== form) form.setAttribute('data-confirm', b.getAttribute('data-confirm-tpl').replace('{n}', String(refresh())));
      var go = e.target && e.target.closest && e.target.closest('[data-labels-go]');
      if (go) {
        var ids = boxes().filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        if (ids.length) location.href = '/labels?ids=' + ids.join(',');
      }
    }, true);
    refresh();
  });

  // 라벨 인쇄
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.hasAttribute && t.hasAttribute('data-print')) window.print();
  });

  // 위험한 버튼 확인창
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // 파일 업로드(상품/주문 가져오기)
  var LABELS = {
    products: [
      ['total', '읽은 행'], ['created', '새로 등록'], ['updated', '정보 갱신'], ['skipped', '건너뜀(오류)'],
      ['initialStock', '초기 재고 반영'], ['barcodesIssued', '바코드 자동 발급'], ['checkDigitWarnings', 'EAN-13 체크디지트 경고'],
    ],
    orders: [
      ['total', '읽은 행'], ['inserted', '새로 등록'], ['pendingNew', '└ 미출고 주문'], ['closedNew', '└ 외부 출고됨'],
      ['canceledNew', '└ 취소'], ['duplicates', '이미 있는 주문(중복)'], ['canceledUpdated', '취소로 갱신'],
      ['closedUpdated', '외부 출고로 갱신'], ['needsReturn', '출고 후 취소·반품 → 반품 필요'],
      ['matchedByName', '상품명으로 자동 매칭'], ['unmatched', '상품 미매칭 → 매칭 대기'], ['addonsIgnored', '추가상품(자수·각인 등) 자동 제외'], ['rematched', '재매칭됨'],
    ],
  };

  var form = document.querySelector('form[data-upload]');
  if (form) {
    var kind = form.getAttribute('data-upload');
    var out = document.getElementById('result');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = form.querySelector('input[type=file]');
      var file = input.files && input.files[0];
      out.textContent = '';
      if (!file) { show('파일을 선택하세요.', 'err'); return; }
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      show('업로드 중… (' + Math.round(file.size / 1024) + 'KB)', 'ok');
      fetch(form.getAttribute('data-url'), {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-csrf-token': form.getAttribute('data-csrf'),
          'x-filename': encodeURIComponent(file.name),
        },
        body: file,
      }).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: '서버 응답을 읽을 수 없습니다 (' + r.status + ').' }; });
      }).then(function (j) {
        btn.disabled = false;
        if (!j.ok) { show(j.error || '가져오기에 실패했습니다.', 'err'); return; }
        render(j.report);
      }).catch(function () {
        btn.disabled = false;
        show('네트워크 오류로 업로드하지 못했습니다.', 'err');
      });
    });

    function show(text, type) {
      out.textContent = '';
      var d = document.createElement('div');
      d.className = 'flash ' + type;
      d.textContent = text;
      out.appendChild(d);
    }

    function render(rep) {
      out.textContent = '';
      var ok = document.createElement('div');
      ok.className = 'flash ok';
      ok.textContent = '가져오기를 마쳤습니다.';
      out.appendChild(ok);
      var box = document.createElement('div');
      box.className = 'card report';
      var dl = document.createElement('dl');
      dl.className = 'kv';
      (LABELS[kind] || []).forEach(function (pair) {
        if (rep[pair[0]] === undefined) return;
        var dt = document.createElement('dt'); dt.textContent = pair[1];
        var dd = document.createElement('dd'); dd.textContent = Number(rep[pair[0]]).toLocaleString('ko-KR');
        dl.appendChild(dt); dl.appendChild(dd);
      });
      [['usedCodeColumn', '상품코드로 사용한 열'], ['usedNameColumn', '상품명으로 사용한 열']].forEach(function (pair) {
        if (!rep[pair[0]]) return;
        var dt2 = document.createElement('dt'); dt2.textContent = pair[1];
        var dd2 = document.createElement('dd'); dd2.textContent = rep[pair[0]];
        dl.appendChild(dt2); dl.appendChild(dd2);
      });
      box.appendChild(dl);
      if (rep.errors && rep.errors.length) {
        var h = document.createElement('h2'); h.textContent = '확인이 필요한 행 (' + rep.errors.length + (rep.errorsTruncated ? '+' : '') + ')';
        box.appendChild(h);
        var wrap = document.createElement('div'); wrap.className = 'table-wrap';
        var table = document.createElement('table');
        var thead = document.createElement('tr');
        ['줄', '이유'].forEach(function (t) { var th = document.createElement('th'); th.textContent = t; thead.appendChild(th); });
        table.appendChild(thead);
        rep.errors.forEach(function (er) {
          var tr = document.createElement('tr');
          var a = document.createElement('td'); a.textContent = er.row;
          var b = document.createElement('td'); b.textContent = er.message;
          tr.appendChild(a); tr.appendChild(b); table.appendChild(tr);
        });
        wrap.appendChild(table); box.appendChild(wrap);
      }
      out.appendChild(box);
    }
  }
})();

// 모바일 메뉴 서랍: Esc 로 닫기
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  var t = document.getElementById('nav-toggle');
  if (t && t.checked) t.checked = false;
});
