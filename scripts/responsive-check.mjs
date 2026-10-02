// 반응형 점검: 여러 화면 크기에서 모든 주요 화면을 열어 레이아웃이 깨지지 않았는지 확인한다.
//   npm run check:responsive              (결과만 출력, 문제가 있으면 종료 코드 1)
//   npm run check:responsive -- --shots   (스크린샷을 responsive-shots/ 에 저장)
// 브라우저는 playwright-core 가 찾은 Chromium 을 쓰며, 없으면 CHROME_PATH 환경 변수나 /opt/pw-browsers 를 찾는다.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createUser } from '../src/lib/auth.js';
import { importProducts } from '../src/lib/products.js';
import { importOrders } from '../src/lib/orders.js';
import { applyStock } from '../src/lib/inventory.js';

const { chromium } = await import('playwright-core').catch(() => {
  console.error('playwright-core 가 필요합니다: npm install (devDependencies 포함)');
  process.exit(2);
});

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch { /* 계속 */ }
  const root = '/opt/pw-browsers';
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      const p = path.join(root, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const shots = process.argv.includes('--shots');
const shotDir = 'responsive-shots';
if (shots) fs.mkdirSync(shotDir, { recursive: true });

// ---- 임시 DB 에 확인용 데이터 준비
const db = openDb(':memory:');
const PASSWORD = 'responsive-check-1234';
createUser(db, { username: 'admin', displayName: '점검 관리자', password: PASSWORD, role: 'admin' });
createUser(db, { username: 'staff', displayName: '점검 직원', password: PASSWORD, role: 'staff' });
const lines = ['상품명,옵션,상품코드,안전재고,현재고'];
for (let i = 1; i <= 120; i++) lines.push(`점검용 야구 글러브 모델 ${i} 아주 긴 상품명 줄바꿈 확인용 문구,색상: 블랙 / 사이즈: ${i % 3 ? 'L' : 'M'},CHK-${i},10,${i % 9}`);
importProducts(db, lines.join('\n'));
const orders = ['주문번호,주문상품번호,쇼핑몰,상품명,수량,주문상태'];
for (let i = 1; i <= 60; i++) orders.push(`CHK-ORD-${i},1,${i % 2 ? '스마트스토어' : '쿠팡'},점검용 야구 글러브 모델 ${i} 아주 긴 상품명 줄바꿈 확인용 문구 / 색상: 블랙 / 사이즈: ${i % 3 ? 'L' : 'M'},${1 + (i % 4)},신규주문`);
orders.push('CHK-ORD-X,1,쿠팡,표기가 다른 점검용 야구 글러브 모델 7 한정판 / 블랙,1,신규주문');
importOrders(db, orders.join('\n'));
const first = db.prepare('SELECT id FROM products ORDER BY id LIMIT 1').get().id;
applyStock(db, { productId: first, holdDelta: 2, eventType: 'RETURN_BAD' });

const app = createApp({ db });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const VIEWPORTS = [
  { name: '폰-작은(360)', width: 360, height: 740 },
  { name: '폰(390)', width: 390, height: 844 },
  { name: '태블릿 세로(768)', width: 768, height: 1024 },
  { name: '태블릿 가로(1024)', width: 1024, height: 768 },
  { name: '노트북(1440)', width: 1440, height: 900 },
];
const PAGES = ['/', '/products', `/products/${first}`, `/products/${first}/edit`, '/products/new', '/products/import', '/ledger', '/adjust',
  '/labels?filter=unprinted&n=1', '/scan/in', '/scan/out', '/orders', '/orders?status=pending', '/orders/import', '/orders/unmatched', '/orders/ship', '/users', '/password'];

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const failures = [];
const note = (vp, page, msg) => failures.push(`[${vp.name}] ${page} — ${msg}`);

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: 'ko-KR', hasTouch: vp.width < 900 });
  await ctx.addCookies([{ name: 'dv', value: vp.width <= 640 ? 'm' : 'd', url: base }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => note(vp, '(script)', e.message));
  await page.goto(`${base}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', PASSWORD);
  await Promise.all([page.waitForURL(`${base}/`), page.click('form[action="/login"] button[type=submit]')]);

  // 1) 모든 화면: 페이지 가로 스크롤이 없고, 본문 요소가 화면 밖으로 나가지 않는다
  for (const p of PAGES) {
    const res = await page.goto(base + p);
    if (res.status() !== 200) { note(vp, p, `HTTP ${res.status()}`); continue; }
    const r = await page.evaluate(() => {
      const w = window.innerWidth;
      const over = [];
      for (const el of document.querySelectorAll('main *')) {
        if (el.closest('.table-wrap') && !el.closest('.table-wrap').matches(':has(> table.stack)')) continue; // 표 영역 안의 가로 스크롤은 허용
        if (el.closest('svg') && el.tagName !== 'svg') continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.right > w + 1 || b.left < -1) over.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} (${Math.round(b.left)}→${Math.round(b.right)} / ${w})`);
        if (over.length >= 3) break;
      }
      const docOver = document.documentElement.scrollWidth > w + 1;
      // 손가락 크기: 폰에서 버튼·입력·선택 상자는 높이 40px 이상
      const small = [];
      if (w <= 640) {
        for (const el of document.querySelectorAll('main button, main .btn, main input:not([type=hidden]):not([type=checkbox]):not([type=file]), main select, .menu-btn')) {
          const b = el.getBoundingClientRect();
          if (b.width && b.height && b.height < 38) small.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.name || '').trim().slice(0, 12)}" ${Math.round(b.height)}px`);
        }
      }
      return { docOver, over, small: small.slice(0, 3), n: small.length };
    });
    if (r.docOver) note(vp, p, '페이지 전체에 가로 스크롤이 생김');
    if (r.over.length) note(vp, p, `화면 밖으로 나간 요소: ${r.over.join(', ')}`);
    if (r.n) note(vp, p, `터치하기 작은 요소 ${r.n}개: ${r.small.join(', ')}`);
  }

  // 2) 메뉴: 넓은 화면은 항상 보이고, 좁은 화면은 ☰ 로 열고 Esc 로 닫는다
  await page.goto(base + '/');
  const mobile = vp.width <= 900;
  const state = async () => page.evaluate(() => {
    const side = document.querySelector('.side').getBoundingClientRect();
    const vis = getComputedStyle(document.querySelector('.side')).visibility;
    return { onScreen: vis !== 'hidden' && side.right > 10, menuBtn: getComputedStyle(document.querySelector('.menu-btn')).display !== 'none' };
  });
  let s = await state();
  if (mobile) {
    if (!s.menuBtn) note(vp, '/', '☰ 메뉴 버튼이 없음');
    if (s.onScreen) note(vp, '/', '메뉴가 닫혀 있어야 하는데 보임');
    await page.click('.menu-btn');
    await page.waitForTimeout(350);
    s = await state();
    if (!s.onScreen) note(vp, '/', '☰ 를 눌러도 메뉴가 열리지 않음');
    if (shots) await page.screenshot({ path: `${shotDir}/${vp.width}-menu-open.png` });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    s = await state();
    if (s.onScreen) note(vp, '/', 'Esc 로 메뉴가 닫히지 않음');
    await page.click('.menu-btn'); await page.waitForTimeout(350);
    try {
      await Promise.all([page.waitForURL(`${base}/products`, { timeout: 4000 }), page.click('.side a[href="/products"]', { timeout: 4000 })]);
    } catch {
      note(vp, '/', '열린 메뉴에서 항목을 눌러 이동하지 못함');
    }
  } else {
    if (s.menuBtn) note(vp, '/', '넓은 화면에 ☰ 버튼이 보임');
    if (!s.onScreen) note(vp, '/', '메뉴가 보이지 않음');
  }

  // 3) 폰: 목록 표가 카드로 바뀌었는지
  if (vp.width <= 640) {
    for (const p of ['/products', '/orders', '/ledger']) {
      await page.goto(base + p);
      const c = await page.evaluate(() => {
        const t = document.querySelector('table.stack');
        const head = t.querySelector('tr.thead');
        const tr = t.querySelectorAll('tr:not(.thead)')[0];
        return { headHidden: getComputedStyle(head).display === 'none', rowDisplay: getComputedStyle(tr).display };
      });
      if (!c.headHidden) note(vp, p, '머리글 행이 숨겨지지 않음 (카드 모양 아님)');
      if (c.rowDisplay === 'table-row') note(vp, p, '행이 카드로 바뀌지 않음');
    }
  }

  // 3-2) 목록 개수: 폰 10개, 그 밖 20개 (+ 쪽 이동)
  {
    const want = vp.width <= 640 ? 10 : 20;
    await page.goto(base + '/products');
    const rowsOnPage = await page.evaluate(() => document.querySelectorAll('table.stack tr:not(.thead)').length);
    if (rowsOnPage !== want) note(vp, '/products', `한 페이지 ${rowsOnPage}개 (기대 ${want}개)`);
    // 쪽이 7개를 넘으면 '쪽 이동' 입력이 나온다 (120개 기준: 폰 12쪽 → 있음, PC 6쪽 → 없음)
    const jump = await page.evaluate(() => !!document.querySelector('.pager-jump'));
    if (jump !== (vp.width <= 640)) note(vp, '/products', `쪽 이동 입력 ${jump ? '이 있음' : '이 없음'} (쪽 수에 맞지 않음)`);
  }

  // 4) 스캔 화면: 스캔 입력과 확정 버튼이 한 화면에서 보이는지
  await page.goto(base + '/scan/in');
  const code = db.prepare('SELECT barcode FROM products ORDER BY id LIMIT 3').all().map((r) => r.barcode);
  for (const b of code) { await page.keyboard.type(b); await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]); }
  const sc = await page.evaluate(() => {
    const input = document.getElementById('code').getBoundingClientRect();
    const btn = document.querySelector('.sticky-confirm button.pri').getBoundingClientRect();
    return { inputInView: input.top >= 0 && input.bottom <= innerHeight, btnInView: btn.top >= 0 && btn.bottom <= innerHeight + 1, focus: document.activeElement.id };
  });
  if (!sc.inputInView) note(vp, '/scan/in', '스캔 입력창이 첫 화면에 보이지 않음');
  if (!sc.btnInView) note(vp, '/scan/in', '확정 버튼이 화면 안에 보이지 않음');
  if (sc.focus !== 'code') note(vp, '/scan/in', '스캔 후 입력창 포커스 유실');

  if (shots) {
    for (const [p, n] of [['/', 'dashboard'], ['/products', 'products'], ['/orders', 'orders'], ['/scan/in', 'scan'], ['/orders/unmatched', 'unmatched'], ['/users', 'users']]) {
      await page.goto(base + p);
      await page.screenshot({ path: `${shotDir}/${vp.width}-${n}.png`, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height: Math.min(1500, await page.evaluate(() => document.documentElement.scrollHeight)) } });
    }
  }
  await ctx.close();
}

{
  // 처음 접속한 폰(쿠키 없음, PC 로 보이는 UA): 서버는 20개로 그리지만 브라우저가 쿠키를 고치고 한 번만 다시 불러와 10개가 된다
  const vp = { name: '폰 첫 방문(390)', width: 390, height: 844 };
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: 'ko-KR', hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', PASSWORD);
  await Promise.all([page.waitForURL(`${base}/`), page.click('form[action="/login"] button[type=submit]')]);
  await page.goto(base + '/products');
  await page.waitForFunction(() => document.body.getAttribute('data-ps') === '10', null, { timeout: 5000 }).catch(() => note(vp, '/products', '첫 방문에서 10개로 바뀌지 않음'));
  const rows = await page.evaluate(() => document.querySelectorAll('table.stack tr:not(.thead)').length);
  if (rows !== 10) note(vp, '/products', `첫 방문 보정 후 ${rows}개 (기대 10개)`);
  const cookies = await ctx.cookies();
  if (cookies.find((c) => c.name === 'dv')?.value !== 'm') note(vp, '/products', 'dv 쿠키가 설정되지 않음');
  await page.goto(base + '/orders');
  if (await page.evaluate(() => document.body.getAttribute('data-ps')) !== '10') note(vp, '/orders', '다른 목록에서 10개가 유지되지 않음');
  await ctx.close();
}

await browser.close();
server.close();
console.log(`점검한 화면 크기 ${VIEWPORTS.length}개 × 화면 ${PAGES.length}개 + 메뉴·카드·스캔 동작`);
if (failures.length) {
  console.log(`\n문제 ${failures.length}건:`);
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
console.log('문제 없음');
