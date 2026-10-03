// 라벨 화면의 "프린터로 바로 출력". 상품 정보를 TSPL 명령으로 바꿔 매장 PC 의 출력 프로그램(print-agent)으로 보낸다.
//  - 가격·상품명(한글)은 화면 글꼴로 그려 이미지로 보내고, 바코드는 프린터 내장 기능으로 그린다.
import { SIZES, labelLayout, monoBitmap, buildLabelJob, buildCalibrate, concatBytes } from './tspl.js';

const KEY = 'stocksync.printer.v1';
const DEFAULTS = { agent: 'http://127.0.0.1:9101', mode: 'windows', printer: '', host: '', port: 9100, gap: 2, density: 8, speed: 4, narrow: 2, reverse: false, invert: false };
const FONT = '"Pretendard","Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif';
const BATCH = 40; // 한 번에 보내는 라벨 종류 수

const $ = (id) => document.getElementById(id);
const panel = $('printer-panel');
if (panel) init();

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 저장이 막혀 있어도 동작에는 영향 없음 */ } }

function init() {
  const sizeKey = panel.dataset.size;
  const fieldsMode = panel.dataset.fields; // price | price_name | barcode
  const kind = panel.dataset.bc === 'ean13' ? 'ean13' : 'code128';
  const settings = load();
  const msg = $('pr-msg');
  const say = (text, type = 'ok') => { msg.textContent = text; msg.className = `pr-msg ${type}`; msg.hidden = !text; };

  // ---- 설정 입력칸 ↔ 저장값
  const fields = { agent: 'text', mode: 'text', printer: 'text', host: 'text', port: 'num', gap: 'num', density: 'num', speed: 'num', narrow: 'num', reverse: 'bool', invert: 'bool' };
  for (const [k, t] of Object.entries(fields)) {
    const el = $(`pr-${k}`);
    if (!el) continue;
    if (t === 'bool') el.checked = Boolean(settings[k]); else el.value = settings[k];
    el.addEventListener('change', () => {
      settings[k] = t === 'bool' ? el.checked : (t === 'num' ? Number(el.value) : el.value.trim());
      save(settings);
      syncMode();
      if (k === 'agent') ping();
    });
  }
  const syncMode = () => {
    panel.querySelectorAll('[data-mode]').forEach((n) => { n.hidden = n.dataset.mode !== settings.mode; });
  };
  syncMode();

  const supported = Boolean(SIZES[sizeKey]);
  const btns = panel.querySelectorAll('button[data-act]');
  const setBusy = (b) => btns.forEach((x) => { x.disabled = b || (x.dataset.act === 'print' && !labelGroups().length) || !supported; });

  // ---- 출력 프로그램 연결 확인
  const statusEl = $('pr-status');
  async function ping() {
    statusEl.className = 'chip'; statusEl.textContent = '확인 중…';
    try {
      const r = await fetch(`${settings.agent}/status`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) throw new Error('bad');
      statusEl.className = 'chip ok'; statusEl.textContent = `연결됨 (v${j.version})`;
      return true;
    } catch {
      statusEl.className = 'chip low'; statusEl.textContent = '출력 프로그램 없음';
      return false;
    }
  }

  // ---- 화면의 라벨 → 출력 묶음 (같은 라벨이 이어지면 장수로 합친다)
  function labelGroups() {
    const out = [];
    document.querySelectorAll('.labels .label').forEach((el) => {
      const price = el.dataset.price === '' ? null : Number(el.dataset.price);
      const name = el.querySelector('.label-name')?.textContent.trim() ?? '';
      const key = `${el.dataset.barcode}|${price}|${name}`;
      const last = out[out.length - 1];
      if (last && last.key === key) last.copies += 1; else out.push({ key, barcode: el.dataset.barcode, price, name, copies: 1 });
    });
    return out;
  }

  // ---- 글자(가격·상품명)를 그려 1비트 이미지로
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t}…`;
  }
  function wrapTwoLines(ctx, text, maxW) {
    const lines = [];
    let cur = '';
    for (const ch of text) {
      if (ctx.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; if (lines.length === 2) break; } else cur += ch;
    }
    if (lines.length < 2 && cur) lines.push(cur);
    if (lines.length === 2 && text.length > lines.join('').length) lines[1] = fitText(ctx, `${lines[1]}…`, maxW);
    return lines.slice(0, 2).map((l) => fitText(ctx, l, maxW));
  }
  function textBitmap(g, L) {
    if (!L.textH) return null;
    const canvas = document.createElement('canvas');
    canvas.width = L.textW; canvas.height = L.textH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    let y = 0;
    if (L.nameH) {
      ctx.font = `700 ${L.nameFont}px ${FONT}`;
      for (const line of wrapTwoLines(ctx, g.name, L.textW - 8)) { ctx.fillText(line, L.textW / 2, y); y += Math.round(L.nameFont * 1.15); }
      y = L.nameH;
    }
    if (L.priceH && g.price !== null) {
      ctx.font = `800 ${L.priceFont}px ${FONT}`;
      ctx.fillText(`${g.price.toLocaleString('ko-KR')}원`, L.textW / 2, y);
    }
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const bmp = monoBitmap(img.data, canvas.width, canvas.height, { blackBit: settings.invert ? 1 : 0 });
    return { x: L.textX, y: L.textY, ...bmp };
  }

  function jobFor(g, copies = g.copies) {
    const { w, h } = SIZES[sizeKey];
    const L = labelLayout(w, h, { showName: fieldsMode === 'price_name' && g.name !== '', showPrice: fieldsMode !== 'barcode' });
    return buildLabelJob({
      widthMm: w, heightMm: h, gapMm: settings.gap, media: 'gap', density: settings.density, speed: settings.speed, reverse: settings.reverse,
      textBitmap: textBitmap(g, L), copies,
      barcode: { value: g.barcode, kind, y: L.barcodeY, height: L.barcodeH, narrow: settings.narrow },
    });
  }

  // ---- 전송
  const target = () => (settings.mode === 'network'
    ? `host=${encodeURIComponent(settings.host)}&port=${settings.port || 9100}`
    : `printer=${encodeURIComponent(settings.printer)}`);
  async function send(bytes) {
    if (settings.mode === 'network' ? !settings.host : !settings.printer) throw new Error('프린터 설정이 비어 있습니다. 아래 “프린터 설정”에서 프린터 이름(또는 IP)을 입력하세요.');
    let r;
    try {
      r = await fetch(`${settings.agent}/print?${target()}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
    } catch {
      throw new Error('출력 프로그램에 연결할 수 없습니다. 매장 PC에서 프로그램이 실행 중인지 확인하세요. (설치 방법은 아래 안내)');
    }
    const j = await r.json().catch(() => ({ ok: false, error: `응답을 읽을 수 없습니다 (${r.status})` }));
    if (!j.ok) throw new Error(j.error || '출력에 실패했습니다.');
  }

  const act = {
    async print() {
      const groups = labelGroups();
      const total = groups.reduce((n, g) => n + g.copies, 0);
      if (!groups.length) return say('출력할 라벨이 없습니다. 위에서 상품을 고르고 미리보기를 누르세요.', 'err');
      if (!window.confirm(`${total.toLocaleString('ko-KR')}장을 프린터로 출력합니다. 계속할까요?`)) return;
      let done = 0;
      for (let i = 0; i < groups.length; i += BATCH) {
        const chunk = groups.slice(i, i + BATCH);
        await send(concatBytes(chunk.map((g) => jobFor(g))));
        done += chunk.reduce((n, g) => n + g.copies, 0);
        say(`출력 중… ${done.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')}장`);
      }
      say(`${total.toLocaleString('ko-KR')}장을 프린터로 보냈습니다. 다 나오면 아래 “출력 완료로 표시”를 누르세요.`);
    },
    async test() {
      const g = { key: 't', barcode: '7700000000019', price: 12900, name: '테스트 라벨 STOCKSYNC', copies: 1 };
      await send(jobFor(g, 1));
      say('테스트 라벨 1장을 보냈습니다. 가격·바코드가 라벨 안에 반듯하게 나오는지 확인하세요.');
    },
    async calibrate() {
      const { w, h } = SIZES[sizeKey];
      await send(buildCalibrate({ widthMm: w, heightMm: h, gapMm: settings.gap, media: 'gap', density: settings.density, speed: settings.speed, reverse: settings.reverse }));
      say('용지 감지를 보냈습니다. 라벨이 몇 장 밀려 나온 뒤 멈추면 정상입니다.');
    },
    async printers() {
      let r;
      try { r = await fetch(`${settings.agent}/printers`); } catch { throw new Error('출력 프로그램에 연결할 수 없습니다.'); }
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '프린터 목록을 가져오지 못했습니다.');
      const list = $('pr-printer-list');
      list.textContent = '';
      for (const n of j.printers) { const o = document.createElement('option'); o.value = n; list.appendChild(o); }
      say(j.printers.length ? `프린터 ${j.printers.length}대를 찾았습니다. “프린터 이름” 칸을 눌러 고르세요.` : '설치된 프린터가 없습니다.', j.printers.length ? 'ok' : 'err');
    },
  };

  btns.forEach((b) => b.addEventListener('click', async () => {
    say('');
    setBusy(true);
    try { await act[b.dataset.act](); } catch (e) { say(e.message, 'err'); }
    setBusy(false);
  }));
  if (!supported) say(`${sizeKey} 규격은 프린터 직접 출력을 지원하지 않습니다 (50×30, 40×25 만 가능). 브라우저 인쇄를 쓰세요.`, 'err');
  setBusy(false);
  ping();
}
