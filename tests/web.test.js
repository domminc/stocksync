import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { memDb, addUser, addProduct, ean, PASSWORD } from './helpers.js';
import { createApp } from '../src/app.js';
import { applyStock } from '../src/lib/inventory.js';
import { importOrders } from '../src/lib/orders.js';
import { makeNameKey } from '../src/lib/namekey.js';

let db, server, base;

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }

  async fetch(path, opts = {}) {
    const res = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: this.cookie, ...(opts.headers ?? {}) } });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0].replace(/^sid=$/, '');
    return res;
  }

  async login(username, password = PASSWORD) {
    const res = await this.fetch('/login', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password, next: '/' }),
    });
    if (res.status === 302) await this.loadCsrf();
    return res;
  }

  async loadCsrf() {
    const html = await (await this.fetch('/')).text();
    this.csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  }

  get(path) { return this.fetch(path); }

  post(path, data = {}, { csrf = this.csrf } = {}) {
    return this.fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...data, ...(csrf ? { _csrf: csrf } : {}) }),
    });
  }

  upload(path, text, filename = 'f.csv') {
    return this.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': this.csrf, 'x-filename': encodeURIComponent(filename) },
      body: Buffer.from(text, 'utf-8'),
    });
  }
}

const flashOf = (res) => decodeURIComponent((res.headers.get('location') ?? '').match(/msg=([^&]*)/)?.[1] ?? '');
const qty = (id) => db.prepare('SELECT qty FROM inventory WHERE product_id = ?').get(id).qty;

before(async () => {
  db = memDb();
  for (const role of ['admin', 'manager', 'staff', 'online', 'viewer']) addUser(db, role);
  const app = createApp({ db });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); });

async function as(role) {
  const c = new Client();
  const res = await c.login(role);
  assert.equal(res.status, 302, `${role} 로그인`);
  return c;
}

test('로그인 전에는 로그인 화면으로 보낸다', async () => {
  const c = new Client();
  const res = await c.get('/products');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login\?next=%2Fproducts/);
});

test('보안 헤더', async () => {
  const res = await new Client().get('/login');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('로그인 쿠키는 HttpOnly + SameSite', async () => {
  const res = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'viewer', password: PASSWORD }),
  });
  const c = res.headers.get('set-cookie');
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
});

test('잘못된 비밀번호는 401, 계정 존재 여부를 알려주지 않는다', async () => {
  const a = await new Client().login('viewer', 'wrong-password-123');
  const b = await new Client().login('nobody', 'wrong-password-123');
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(await a.text(), await b.text());
});

test('로그인 반복 실패 시 잠긴다 (맞는 비밀번호도 거부)', async () => {
  db.prepare("DELETE FROM login_attempts").run();
  for (let i = 0; i < 5; i++) await new Client().login('online', 'wrong-password-123');
  const res = await new Client().login('online');
  assert.equal(res.status, 429);
  db.prepare("DELETE FROM login_attempts").run();
  assert.equal((await new Client().login('online')).status, 302);
});

test('로그인 후 이동 주소는 사이트 안으로만 (open redirect 방지)', async () => {
  for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
    const res = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'viewer', password: PASSWORD, next: evil }),
    });
    assert.equal(res.headers.get('location'), '/', evil);
  }
});

test('CSRF 토큰 없이는 쓰기 요청이 거부된다', async () => {
  const c = await as('manager');
  assert.equal((await c.post('/products', { barcode: ean(900), name: 'x' }, { csrf: '' })).status, 403);
  assert.equal((await c.post('/products', { barcode: ean(900), name: 'x' }, { csrf: 'wrong' })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products WHERE barcode = ?').get(ean(900)).n, 0);
  assert.equal((await c.post('/products', { barcode: ean(900), name: '정상' })).status, 302);
});

test('로그아웃하면 이전 세션 쿠키는 쓸 수 없다', async () => {
  const c = await as('viewer');
  const old = c.cookie;
  assert.equal((await c.get('/')).status, 200);
  await c.post('/logout');
  const res = await fetch(`${base}/`, { redirect: 'manual', headers: { cookie: old } });
  assert.equal(res.status, 302);
});

test('역할별 접근 권한 (화면 접근)', async () => {
  const matrix = {
    admin: { '/': 200, '/users': 200, '/adjust': 200, '/scan/in': 200, '/orders/import': 200, '/products/import': 200, '/orders/ship': 200, '/labels': 200 },
    manager: { '/': 200, '/users': 403, '/adjust': 200, '/scan/out': 200, '/orders/import': 200, '/products/import': 200 },
    staff: { '/': 200, '/labels': 200, '/products': 200, '/scan/in': 200, '/scan/out': 200, '/adjust': 403, '/products/import': 403, '/orders/import': 403, '/orders/ship': 403, '/users': 403, '/products/new': 403 },
    online: { '/': 200, '/labels': 403, '/orders': 200, '/orders/import': 200, '/orders/ship': 200, '/orders/unmatched': 200, '/scan/in': 403, '/adjust': 403, '/products/import': 403, '/users': 403 },
    viewer: { '/': 200, '/labels': 403, '/products': 200, '/ledger': 200, '/orders': 200, '/scan/in': 403, '/scan/out': 403, '/adjust': 403, '/orders/ship': 403, '/orders/import': 403, '/users': 403 },
  };
  for (const [role, paths] of Object.entries(matrix)) {
    const c = await as(role);
    for (const [path, want] of Object.entries(paths)) {
      assert.equal((await c.get(path)).status, want, `${role} GET ${path}`);
    }
  }
});

test('조회 전용·직원은 쓰기 요청도 서버에서 막힌다', async () => {
  const id = addProduct(db, 700);
  const staff = await as('staff');
  assert.equal((await staff.post('/adjust', { product_id: id, counted: 5, reason: '시도' })).status, 403);
  assert.equal((await staff.post('/products', { barcode: ean(701), name: 'x' })).status, 403);
  assert.equal((await staff.upload('/products/import', '바코드,상품명\n1234,x')).status, 403);
  const viewer = await as('viewer');
  assert.ok([403, 404].includes((await viewer.post('/scan/1/confirm')).status), '남의/권한 밖 스캔 작업은 처리되지 않는다');
  assert.equal((await viewer.post('/orders/1/ship')).status, 403);
  assert.equal(qty(id), 0);
});

test('매장 직원 입고 스캔 → 확정하면 재고와 원장에 반영', async () => {
  const id = addProduct(db, 710);
  const c = await as('staff');
  const page = await (await c.get('/scan/in')).text();
  const sid = /action="\/scan\/(\d+)\/code"/.exec(page)[1];

  let r = await c.post(`/scan/${sid}/code`, { code: ` ${ean(710)}\n` });
  assert.equal(r.status, 302);
  await c.post(`/scan/${sid}/code`, { code: ean(710) });
  r = await c.post(`/scan/${sid}/code`, { code: '0000000000000' });
  assert.match(flashOf(r), /등록되지 않은 바코드/);
  assert.match(r.headers.get('location'), /t=err/);
  assert.equal(qty(id), 0, '확정 전에는 재고가 바뀌지 않는다');

  const lineId = db.prepare('SELECT id FROM scan_lines WHERE session_id = ?').get(sid).id;
  await c.post(`/scan/${sid}/line/${lineId}`, { qty: 5 });
  r = await c.post(`/scan/${sid}/confirm`, { note: '테스트 입고' });
  assert.match(flashOf(r), /입고 확정: 1품목 5개/);
  assert.equal(qty(id), 5);
  const led = db.prepare("SELECT event_type, qty_delta, reason, user_id FROM stock_ledger WHERE product_id = ?").get(id);
  assert.equal(led.event_type, 'IN');
  assert.equal(led.qty_delta, 5);
  assert.equal(led.reason, '테스트 입고');
  assert.ok(led.user_id);

  r = await c.post(`/scan/${sid}/confirm`);
  assert.match(flashOf(r), /이미 처리/);
  assert.equal(qty(id), 5, '중복 확정(더블클릭)은 재고를 두 번 바꾸지 않는다');
});

test('출고 스캔: 재고가 모자라면 전체 확정 거부', async () => {
  const a = addProduct(db, 720);
  const b = addProduct(db, 721);
  applyStock(db, { productId: a, qtyDelta: 5, eventType: 'IN' });
  applyStock(db, { productId: b, qtyDelta: 1, eventType: 'IN' });
  const c = await as('staff');
  const sid = /action="\/scan\/(\d+)\/code"/.exec(await (await c.get('/scan/out')).text())[1];
  await c.post(`/scan/${sid}/code`, { code: ean(720) });
  await c.post(`/scan/${sid}/code`, { code: ean(721) });
  await c.post(`/scan/${sid}/code`, { code: ean(721) });
  const r = await c.post(`/scan/${sid}/confirm`);
  assert.match(flashOf(r), /재고가 부족해 확정하지 않았습니다/);
  assert.equal(qty(a), 5);
  assert.equal(qty(b), 1);
});

test('다른 사용자의 스캔 작업에는 접근할 수 없다', async () => {
  const staff = await as('staff');
  const sid = /action="\/scan\/(\d+)\/code"/.exec(await (await staff.get('/scan/in')).text())[1];
  const mgr = await as('manager');
  assert.equal((await mgr.post(`/scan/${sid}/code`, { code: ean(710) })).status, 404);
  assert.equal((await mgr.post(`/scan/${sid}/confirm`)).status, 404);
});

test('관리자·매장 관리자는 CSV로 상품을 가져온다 (원본 한글 CP949도 가능)', async () => {
  const c = await as('manager');
  const res = await c.upload('/products/import', `바코드,상품명,현재고\n${ean(800)},가져온 상품,7\n${ean(801)},두번째,0`);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.report.created, 2);
  assert.equal(qty(db.prepare('SELECT id FROM products WHERE barcode = ?').get(ean(800)).id), 7);
  const bad = await c.upload('/products/import', '바코드\n8800000000015');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /상품명/);
  assert.equal((await c.upload('/products/import', '')).status, 400);
});

test('온라인 주문 가져오기 → 출고 스캔으로 출고확정하면 그때 재고 차감', async () => {
  const id = addProduct(db, 810);
  applyStock(db, { productId: id, qtyDelta: 3, eventType: 'IN' });
  const c = await as('online');
  const res = await c.upload('/orders/import', `주문번호,바코드,상품명,수량,주문상태,수령인\nW1,${ean(810)},웹주문,2,신규주문,홍길동\nW2,${ean(810)},웹주문,2,신규주문,김철수`, 'orders.csv');
  assert.equal((await res.json()).report.pendingNew, 2);
  assert.equal(qty(id), 3, '주문을 가져와도 재고는 그대로');

  let r = await c.post('/orders/ship/scan', { code: ean(810) });
  assert.match(flashOf(r), /출고확정: W1/);
  assert.equal(qty(id), 1);
  r = await c.post('/orders/ship/scan', { code: ean(810) });
  assert.match(flashOf(r), /재고 부족/);
  assert.equal(qty(id), 1);
  assert.equal(db.prepare("SELECT status FROM order_lines WHERE order_no = 'W2'").get().status, 'pending');
  const page = await (await c.get('/orders?status=pending')).text();
  assert.ok(!page.includes('홍길동'), '개인정보는 화면에도 없다');
});

test('상품 연결 후 매칭 대기가 풀린다', async () => {
  const id = addProduct(db, 820);
  const c = await as('online');
  await c.upload('/orders/import', '주문번호,상품코드,상품명,수량\nL1,PA-LINK-1,연결할 상품,1');
  const r = await c.post('/orders/unmatched/link', { key: 'PA-LINK-1', barcode: ean(820) });
  assert.match(flashOf(r), /연결했습니다/);
  assert.equal(db.prepare("SELECT product_id FROM order_lines WHERE order_no = 'L1'").get().product_id, id);
});

test('상품명에 들어간 스크립트는 이스케이프된다 (XSS)', async () => {
  const evil = '<script>alert(1)</script>';
  addProduct(db, 830, { name: evil });
  const c = await as('viewer');
  const html = await (await c.get('/products?q=script')).text();
  assert.ok(!html.includes(evil));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('마지막 관리자는 중지·강등할 수 없다', async () => {
  const c = await as('admin');
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  let r = await c.post(`/users/${adminId}`, { display_name: '관리자', role: 'viewer', active: '1' });
  assert.match(flashOf(r), /마지막 관리자/);
  r = await c.post(`/users/${adminId}`, { display_name: '관리자', role: 'admin' });
  assert.match(flashOf(r), /마지막 관리자/);
  assert.equal(db.prepare('SELECT role, active FROM users WHERE id = ?').get(adminId).role, 'admin');
});

test('사용자 추가 / 역할 변경 시 기존 로그인이 풀린다', async () => {
  const admin = await as('admin');
  let r = await admin.post('/users', { username: 'newbie', display_name: '신입', role: 'staff', password: 'a-long-password-1' });
  assert.match(flashOf(r), /계정을 만들었습니다/);
  r = await admin.post('/users', { username: 'newbie', display_name: '중복', role: 'staff', password: 'a-long-password-1' });
  assert.match(flashOf(r), /이미 사용 중/);
  r = await admin.post('/users', { username: 'weak', display_name: '약함', role: 'staff', password: 'short' });
  assert.match(flashOf(r), /10자/);

  const newbie = new Client();
  assert.equal((await newbie.login('newbie', 'a-long-password-1')).status, 302);
  assert.equal((await newbie.get('/adjust')).status, 403);
  const id = db.prepare("SELECT id FROM users WHERE username = 'newbie'").get().id;
  await admin.post(`/users/${id}`, { display_name: '신입', role: 'manager', active: '1' });
  assert.equal((await newbie.get('/')).status, 302, '역할이 바뀌면 다시 로그인해야 한다');
});

test('CSV 내려받기는 엑셀 수식 삽입을 막는다', async () => {
  addProduct(db, 840, { name: '=HYPERLINK("http://evil")' });
  const c = await as('viewer');
  const res = await c.get('/products/export.csv');
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], '엑셀에서 한글이 깨지지 않도록 UTF-8 BOM');
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil"")"`));
});

test('존재하지 않는 주소는 404', async () => {
  const c = await as('viewer');
  assert.equal((await c.get('/nope')).status, 404);
  assert.equal((await c.get('/products/999999')).status, 404);
});

test('CSP 호환: 화면에 인라인 style·script·이벤트 속성이 없다', async () => {
  const c = await as('admin');
  const id = addProduct(db, 850);
  importOrders(db, `주문번호,바코드,수량\nCSP1,${ean(850)},1\nCSP2,NOPE-1,1`);
  const paths = ['/', '/products', `/products/${id}`, `/products/${id}/edit`, '/products/new', '/products/import', '/ledger', '/adjust',
    `/adjust?code=${ean(850)}`, `/labels?ids=${id}`, '/labels?filter=unprinted', '/labels?filter=unprinted&size=a4&copies=stock', '/scan/in', '/scan/out', '/orders', '/orders/import', '/orders/unmatched', '/orders/ship', '/users', '/password'];
  for (const path of paths) {
    const res = await c.get(path);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.ok(!/\sstyle\s*=/.test(html), `${path}: 인라인 style 속성`);
    assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), `${path}: 인라인 script`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${path}: 이벤트 핸들러 속성`);
  }
  assert.ok(!/\sstyle\s*=/.test(await (await new Client().get('/login')).text()), '/login');
});

test('상품 등록 화면: 바코드를 비우면 자체 바코드가 발급되고 라벨을 인쇄할 수 있다', async () => {
  const c = await as('manager');
  const r = await c.post('/products', { barcode: '', name: '자동 발급 테스트 글러브', option_name: '빨강/L', safety_stock: '0', tracked: '1' });
  assert.equal(r.status, 302);
  const id = Number(/\/products\/(\d+)/.exec(r.headers.get('location'))[1]);
  const p = db.prepare('SELECT barcode, barcode_source FROM products WHERE id = ?').get(id);
  assert.match(p.barcode, /^20\d{11}$/);
  assert.equal(p.barcode_source, 'issued');
  const page = await (await c.get(`/labels?ids=${id}&n=3`)).text();
  assert.equal((page.match(/class="label"/g) || []).length, 3, '3장');
  assert.equal((page.match(/<svg class="barcode"/g) || []).length, 3);
  assert.ok(page.includes(`aria-label="바코드 ${p.barcode}"`));
  assert.ok(page.includes('자동 발급 테스트 글러브'));
  // 출력 완료 표시
  assert.equal(db.prepare('SELECT label_printed_at FROM products WHERE id = ?').get(id).label_printed_at, null);
  const done = await c.post('/labels/printed', { ids: String(id) });
  assert.match(flashOf(done), /출력 완료/);
  assert.ok(db.prepare('SELECT label_printed_at FROM products WHERE id = ?').get(id).label_printed_at);
});

test('라벨: 재고 수량만큼, 한 번에 최대 3000장, 직원도 인쇄 가능 / 조회 전용은 불가', async () => {
  const id = addProduct(db, 860);
  applyStock(db, { productId: id, qtyDelta: 4, eventType: 'IN' });
  const staff = await as('staff');
  const page = await (await staff.get(`/labels?ids=${id}&copies=stock`)).text();
  assert.equal((page.match(/class="label"/g) || []).length, 4);
  assert.equal((await (await as('viewer')).post('/labels/printed', { ids: String(id) })).status, 403);
  assert.equal((await staff.get('/labels?ids=abc')).status, 200, '잘못된 ids 는 무시');
});

test('매칭 대기 화면: 후보 제안 → 버튼으로 연결, 무시 처리', async () => {
  const c = await as('online');
  const target = createProductForWeb('화면테스트 글러브 WXY777', '블랙');
  // 표기가 달라 이름 키로는 못 찾는 주문(→ 후보 제안 대상)과, 재고와 무관한 서비스 주문
  importOrders(db, '주문번호,상품명,수량\nU4,화면테스트 글러브 WXY777 블랙 한정판 / 색상: 블랙,2\nU3,재고무관 서비스 / 선택: 아니오,1');
  assert.equal(db.prepare("SELECT product_id FROM order_lines WHERE order_no = 'U4'").get().product_id, null);
  const key4 = db.prepare("SELECT match_key FROM order_lines WHERE order_no = 'U4'").get().match_key;

  const html = await (await c.get('/orders/unmatched')).text();
  assert.ok(html.includes('이 상품으로 연결'), '후보 버튼');
  assert.ok(html.includes('WXY777'));
  let r = await c.post('/orders/unmatched/link', { key: key4, product_id: String(target) });
  assert.match(flashOf(r), /연결했습니다/);
  assert.equal(db.prepare("SELECT product_id FROM order_lines WHERE order_no = 'U4'").get().product_id, target);

  const keyU3 = db.prepare("SELECT match_key FROM order_lines WHERE order_no = 'U3'").get().match_key;
  assert.equal((await (await as('staff')).post('/orders/unmatched/ignore', { key: keyU3 })).status, 403);
  r = await c.post('/orders/unmatched/ignore', { key: keyU3 });
  assert.match(flashOf(r), /재고와 무관/);
  assert.equal(db.prepare("SELECT status FROM order_lines WHERE order_no = 'U3'").get().status, 'closed');
});

function createProductForWeb(name, option) {
  const r = db.prepare("INSERT INTO products (sku_code, barcode, name, option_name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', '')")
    .run(`W-${name}`, ean(870 + name.length), name, option, makeNameKey(name, option));
  db.prepare("INSERT INTO inventory (product_id, qty, hold, updated_at) VALUES (?, 5, 0, '')").run(Number(r.lastInsertRowid));
  return Number(r.lastInsertRowid);
}

test('반응형: 접이식 메뉴 구조와, 카드로 바뀌는 목록 표의 모든 칸에 라벨이 있다', async () => {
  const c = await as('admin');
  const pid = addProduct(db, 880);
  applyStock(db, { productId: pid, qtyDelta: 3, eventType: 'IN' });
  importOrders(db, `주문번호,바코드,수량\nRS1,${ean(880)},1`);
  const shell = await (await c.get('/')).text();
  assert.match(shell, /<meta name="viewport" content="width=device-width, initial-scale=1/);
  assert.match(shell, /<input type="checkbox" id="nav-toggle"/);
  assert.match(shell, /<label for="nav-toggle" class="menu-btn"/);
  assert.match(shell, /<label for="nav-toggle" class="scrim"/);
  for (const path of ['/', '/products', '/orders', '/ledger', `/products/${pid}`, '/orders/ship', '/scan/in']) {
    const html = await (await c.get(path)).text();
    for (const [table] of html.matchAll(/<table class="stack">[\s\S]*?<\/table>/g)) {
      assert.match(table, /<tr class="thead">/, `${path}: 머리글 행`);
      const tds = [...table.matchAll(/<td\b([^>]*)>/g)].map((m) => m[1]);
      assert.ok(tds.length > 0, `${path}: 데이터 행`);
      for (const attrs of tds) {
        assert.ok(/data-label="[^"]+"/.test(attrs) || /class="[^"]*\b(title|acts)\b/.test(attrs), `${path}: 라벨 없는 칸 <td${attrs}>`);
      }
    }
  }
});

test('반응형: 모바일 규칙이 인쇄에 적용되지 않는다 (screen 조건)', async () => {
  const css = await (await fetch(`${base}/static/style.css`)).text();
  const widthQueries = [...css.matchAll(/@media\s*([^{]+)\{/g)].map((m) => m[1].trim()).filter((q) => /max-width|min-width/.test(q));
  assert.ok(widthQueries.length >= 3);
  for (const q of widthQueries) assert.match(q, /^screen\s+and/, `@media ${q}`);
});
