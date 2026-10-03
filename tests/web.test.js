import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { memDb, addUser, addProduct, ean, PASSWORD } from './helpers.js';
import { createApp } from '../src/app.js';
import { applyStock } from '../src/lib/inventory.js';
import { importOrders } from '../src/lib/orders.js';
import { makeNameKey } from '../src/lib/namekey.js';
import { createUser, minPasswordLength, validatePassword } from '../src/lib/auth.js';

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
    const html = await (await this.fetch('/password')).text();
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
  const first = await newbie.get('/adjust');
  assert.equal(first.status, 302, '임시 비밀번호로 처음 로그인하면 다른 화면 대신 비밀번호 변경으로');
  assert.match(first.headers.get('location'), /^\/password/);
  assert.equal((await newbie.post('/password', { current: 'a-long-password-1', next: 'own-secret-pass-7', confirm: 'own-secret-pass-7' })).status, 302);
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
  assert.match(p.barcode, /^77\d{11}$/);
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
        assert.ok(/data-label="[^"]+"/.test(attrs) || /class="[^"]*\b(title|acts|sel)\b/.test(attrs), `${path}: 라벨 없는 칸 <td${attrs}>`);
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

test('목록 개수: 폰 10개 / PC 20개 (쿠키 → 없으면 접속 기기로 추정)', async () => {
  for (let i = 0; i < 100; i++) addProduct(db, 2000 + i, { name: `개수확인 상품 ${i}` });
  const c = await as('viewer');
  const rows = async (path, headers = {}) => {
    const res = await fetch(base + path, { redirect: 'manual', headers: { cookie: c.cookie, ...headers } });
    const html = await res.text();
    return { rows: (html.match(/<td class="title"/g) || []).length, html };
  };
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
  assert.equal((await rows('/products?q=개수확인')).rows, 20, '기본(PC)');
  assert.equal((await rows('/products?q=개수확인', { 'user-agent': IPHONE })).rows, 10, '폰으로 보이는 기기');
  assert.equal((await rows('/products?q=개수확인', { cookie: `${c.cookie}; dv=m` })).rows, 10, '쿠키: 폰');
  assert.equal((await rows('/products?q=개수확인', { cookie: `${c.cookie}; dv=d`, 'user-agent': IPHONE })).rows, 20, '쿠키가 접속 기기 추정보다 우선');
  const p2 = await rows('/products?q=개수확인&page=3', { cookie: `${c.cookie}; dv=m` });
  assert.equal(p2.rows, 10);
  assert.match(p2.html, /3\/10쪽/);
  assert.match(p2.html, /data-ps="10"/);
  // 쪽이 7개 이하(PC 20개씩 5쪽)면 쪽 이동 입력이 없다
  assert.ok(!/class="pager-jump"/.test((await rows('/products?q=개수확인')).html), '5쪽이면 이동 입력 없음');
  assert.ok(/class="pager-jump"/.test(p2.html), '10쪽이면 이동 입력 있음');
  // 쪽이 많으면 쪽 이동 입력 (검색 조건 유지)
  const many = await rows('/products?filter=out&page=2', { cookie: `${c.cookie}; dv=m` });
  assert.equal(many.rows, 10);
  assert.match(many.html, /class="pager-jump"/);
  assert.match(many.html, /name="filter" value="out"/);
  // 다른 목록도 같은 규칙
  const led = (await rows('/ledger', { cookie: `${c.cookie}; dv=m` })).rows;
  assert.ok(led > 0 && led <= 10, `원장 ${led}건`);
  assert.equal((await rows('/orders', { cookie: `${c.cookie}; dv=m` })).rows <= 10, true);
});

// ---------- 계정 관리 ----------
const tempOf = (html) => /class="temp-password"[^>]*>([^<]+)</.exec(html)?.[1];

test('계정 관리: 비밀번호 초기화 → 임시 비밀번호는 그 화면에서만, 첫 로그인은 비밀번호 변경부터', async () => {
  createUserForWeb('resetme', 'staff', 'old-password-12345');
  const admin = await as('admin');
  const id = db.prepare("SELECT id FROM users WHERE username = 'resetme'").get().id;
  const old = new Client();
  assert.equal((await old.login('resetme', 'old-password-12345')).status, 302);

  const res = await admin.post(`/users/${id}/reset`);
  assert.equal(res.status, 200, '리다이렉트하지 않고 한 번만 보여 준다 (주소·기록에 비밀번호가 남지 않게)');
  const temp = tempOf(await res.text());
  assert.match(temp, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
  assert.ok(!/[01OIl]/.test(temp.replace(/-/g, '')), '헷갈리는 글자 제외');

  assert.equal((await old.get('/products')).status, 302, '초기화하면 기존 로그인은 끊긴다');
  assert.equal((await new Client().login('resetme', 'old-password-12345')).status, 401, '예전 비밀번호는 못 씀');

  const u = new Client();
  assert.equal((await u.login('resetme', temp)).status, 302);
  const blocked = await u.get('/products');
  assert.equal(blocked.status, 302);
  assert.match(blocked.headers.get('location'), /^\/password/);
  assert.equal((await u.post('/scan/1/confirm')).status, 403, '변경 전에는 쓰기도 막힘');
  assert.equal((await u.get('/password')).status, 200);
  // 규칙: 아이디 포함 / 현재와 동일 / 확인 불일치 / 짧음
  const rule = async (next, confirm = next) => flashOf(await u.post('/password', { current: temp, next, confirm }));
  assert.match(await rule('resetme-secret-99'), /아이디를 포함/);
  assert.match(await rule(temp), /다른 비밀번호|10자/);
  assert.match(await rule('short'), /10자/);
  assert.match(await rule('another-secret-88', 'different-secret-88'), /일치하지/);
  const ok = await u.post('/password', { current: temp, next: 'my-new-secret-2026', confirm: 'my-new-secret-2026' });
  assert.equal(ok.status, 302);
  assert.equal((await u.get('/products')).status, 200);
  assert.equal(db.prepare("SELECT must_change_password FROM users WHERE username = 'resetme'").get().must_change_password, 0);

  // 임시 비밀번호는 어디에도 남지 않는다
  const dump = JSON.stringify(db.prepare('SELECT * FROM audit_log').all()) + JSON.stringify(db.prepare('SELECT username, password_hash FROM users').all());
  assert.ok(!dump.includes(temp));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.reset' AND detail = 'resetme'").get());
  assert.ok(!(await (await admin.get('/users')).text()).includes(temp));
});

test('계정 관리: 초기화는 로그인 잠금도 풀고, 직접 지정한 비밀번호도 첫 로그인 때 바꾸게 한다', async () => {
  createUserForWeb('locked1', 'staff', 'old-password-12345');
  createUserForWeb('setpw1', 'staff', 'old-password-12345');
  const admin = await as('admin');
  const lockedId = db.prepare("SELECT id FROM users WHERE username = 'locked1'").get().id;
  const setId = db.prepare("SELECT id FROM users WHERE username = 'setpw1'").get().id;

  for (let i = 0; i < 5; i++) await new Client().login('locked1', 'wrong-password-123');
  assert.equal((await new Client().login('locked1', 'old-password-12345')).status, 429);
  assert.match(await (await admin.get('/users')).text(), /로그인 잠김/);
  let r = await admin.post(`/users/${lockedId}/unlock`);
  assert.match(flashOf(r), /잠금을 풀었습니다/);
  assert.equal((await new Client().login('locked1', 'old-password-12345')).status, 302);

  r = await admin.post(`/users/${setId}/password`, { password: 'setpw1-weak-1' });
  assert.match(flashOf(r), /아이디를 포함/);
  r = await admin.post(`/users/${setId}/password`, { password: 'short' });
  assert.match(flashOf(r), /10자/);
  r = await admin.post(`/users/${setId}/password`, { password: 'assigned-by-admin-5' });
  assert.match(flashOf(r), /지정했습니다/);
  const u = new Client();
  assert.equal((await u.login('setpw1', 'assigned-by-admin-5')).status, 302);
  assert.match((await u.get('/products')).headers.get('location'), /^\/password/);
});

test('계정 관리: 관리자만, 내 비밀번호는 초기화·지정 불가, 없는 계정 처리', async () => {
  const admin = await as('admin');
  const me = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  assert.match(flashOf(await admin.post(`/users/${me}/reset`)), /비밀번호 변경/);
  assert.match(flashOf(await admin.post(`/users/${me}/password`, { password: 'whatever-secret-1' })), /비밀번호 변경/);
  assert.match(flashOf(await admin.post('/users/999999/reset')), /찾을 수 없습니다/);
  const other = db.prepare("SELECT id FROM users WHERE username = 'viewer'").get().id;
  for (const role of ['manager', 'staff', 'online', 'viewer']) {
    const c = await as(role);
    for (const path of [`/users/${other}/reset`, `/users/${other}/password`, `/users/${other}/unlock`]) {
      assert.equal((await c.post(path, { password: 'whatever-secret-1' })).status, 403, `${role} ${path}`);
    }
  }
});

test('계정 관리: 화면에 계정 목록·현황·활동 기록이 보이고 jiny 같은 관리자 아이디를 만들 수 있다', async () => {
  createUserForWeb('jiny', 'admin', 'jiny-first-secret-1');
  const jiny = new Client();
  assert.equal((await jiny.login('jiny', 'jiny-first-secret-1')).status, 302);
  const html = await (await jiny.get('/users')).text();
  assert.match(html, /@jiny/);
  assert.match(html, /계정 관리/);
  assert.match(html, /최근 계정 활동/);
  assert.match(html, /비밀번호 초기화/);
  assert.match(html, /비밀번호 직접 지정/);
  const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'user.%'").get().n;
  const ch = await jiny.post('/password', { current: 'jiny-first-secret-1', next: 'jiny-second-secret-2', confirm: 'jiny-second-secret-2' });
  assert.equal(ch.status, 302);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'password.change'").get());
  assert.ok(before >= 0);
});

function createUserForWeb(username, role, password) {
  return createUser(db, { username, displayName: `${username} 사용자`, password, role });
}

// ---------- 비밀번호 최소 길이 설정 / 계정 삭제 ----------
test('서버 설정 PASSWORD_MIN_LENGTH: 기본 10자, 6~64 범위, 화면·검사에 모두 반영', async () => {
  const prev = process.env.PASSWORD_MIN_LENGTH;
  try {
    delete process.env.PASSWORD_MIN_LENGTH;
    assert.equal(minPasswordLength(), 10);
    assert.match(validatePassword('abc123xy'), /10자/);
    process.env.PASSWORD_MIN_LENGTH = '6';
    assert.equal(minPasswordLength(), 6);
    assert.equal(validatePassword('abc123'), null);
    assert.match(validatePassword('abc12'), /6자/);
    process.env.PASSWORD_MIN_LENGTH = '3';
    assert.equal(minPasswordLength(), 6, '너무 짧게는 설정할 수 없다');
    process.env.PASSWORD_MIN_LENGTH = '500';
    assert.equal(minPasswordLength(), 64);
    process.env.PASSWORD_MIN_LENGTH = 'abc';
    assert.equal(minPasswordLength(), 10);

    process.env.PASSWORD_MIN_LENGTH = '6';
    createUserForWeb('shortpw', 'staff', 'old-password-12345');
    const u = new Client();
    assert.equal((await u.login('shortpw', 'old-password-12345')).status, 302);
    const page = await (await u.get('/password')).text();
    assert.match(page, /6자 이상/);
    assert.match(page, /minlength="6"/);
    assert.equal((await u.post('/password', { current: 'old-password-12345', next: 'zq9x7k', confirm: 'zq9x7k' })).status, 302);
    assert.equal((await new Client().login('shortpw', 'zq9x7k')).status, 302);
    assert.equal((await new Client().login('shortpw', 'old-password-12345')).status, 401);
    // 아이디 포함 금지는 길이와 무관하게 유지
    assert.match(validatePassword('shortpw1', { username: 'shortpw' }), /아이디/);
  } finally {
    if (prev === undefined) delete process.env.PASSWORD_MIN_LENGTH; else process.env.PASSWORD_MIN_LENGTH = prev;
  }
});

test('계정 삭제: 확인 아이디 필수, 로그인 불가, 목록에서 사라지고 아이디 재사용 가능, 기록은 보존', async () => {
  const gone = createUserForWeb('leaver', 'staff', 'old-password-12345');
  const admin = await as('admin');
  // 삭제 전에 이 사람이 한 일을 남겨 둔다
  const pid = addProduct(db, 3001);
  applyStock(db, { productId: pid, qtyDelta: 4, eventType: 'IN', reason: '퇴사 전 입고', userId: gone });
  const leaver = new Client();
  assert.equal((await leaver.login('leaver', 'old-password-12345')).status, 302);
  const sid = /action="\/scan\/(\d+)\/code"/.exec(await (await leaver.get('/scan/in')).text())[1];
  const stillLoggedIn = leaver.cookie;

  let r = await admin.post(`/users/${gone}/delete`, { confirm_username: 'wrong' });
  assert.match(flashOf(r), /아이디를 정확히/);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL').get(gone), '확인 실패 시 그대로');
  r = await admin.post(`/users/${gone}/delete`, {});
  assert.match(flashOf(r), /아이디를 정확히/);

  r = await admin.post(`/users/${gone}/delete`, { confirm_username: ' LEAVER ' });
  assert.match(flashOf(r), /삭제했습니다/);

  assert.equal((await new Client().login('leaver', 'old-password-12345')).status, 401, '삭제된 계정은 로그인 불가');
  const res = await fetch(`${base}/products`, { redirect: 'manual', headers: { cookie: stillLoggedIn } });
  assert.equal(res.status, 302, '로그인 중이던 기기도 끊김');
  assert.equal(db.prepare('SELECT status FROM scan_sessions WHERE id = ?').get(sid).status, 'discarded');

  const list = await (await admin.get('/users')).text();
  assert.ok(!list.includes('@leaver'), '목록에서 사라짐');
  assert.match(list, /계정 삭제/, '활동 기록에는 남음');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.delete' AND detail LIKE 'leaver%'").get());

  // 재고 원장의 처리자 이름은 보존
  const ledger = await (await admin.get('/ledger?q=' + encodeURIComponent(db.prepare('SELECT barcode FROM products WHERE id = ?').get(pid).barcode))).text();
  assert.match(ledger, /leaver 사용자/);

  // 같은 아이디를 새 사람에게 다시 쓸 수 있다
  assert.match(flashOf(await admin.post('/users', { username: 'leaver', display_name: '새 직원', role: 'staff', password: 'brand-new-temp-77' })), /계정을 만들었습니다/);
  // 삭제된 계정은 조작할 수 없다
  assert.match(flashOf(await admin.post(`/users/${gone}/reset`)), /찾을 수 없습니다/);
  assert.match(flashOf(await admin.post(`/users/${gone}/delete`, { confirm_username: 'leaver' })), /찾을 수 없습니다/);
});

test('계정 삭제: 내 계정·마지막 관리자는 삭제 불가, 관리자만 삭제 가능', async () => {
  const admin = await as('admin');
  const me = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  assert.match(flashOf(await admin.post(`/users/${me}/delete`, { confirm_username: 'admin' })), /내 계정은 삭제할 수 없습니다/);
  // 관리자가 둘일 때만 다른 관리자를 삭제할 수 있다 → 둘째 관리자 만들고 삭제는 되지만, 첫째는 마지막이 되어 보호
  const second = createUserForWeb('admin2', 'admin', 'second-admin-secret-1');
  const a2 = new Client(); assert.equal((await a2.login('admin2', 'second-admin-secret-1')).status, 302);
  assert.match(flashOf(await a2.post(`/users/${me}/delete`, { confirm_username: 'admin' })), /삭제했습니다/, '관리자가 둘이면 서로 삭제 가능');
  const last = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND deleted_at IS NULL").get().n;
  assert.ok(last >= 1);
  // 관리자 이외는 불가
  const other = db.prepare("SELECT id FROM users WHERE username = 'viewer'").get().id;
  for (const role of ['manager', 'staff', 'online', 'viewer']) {
    const c = await as(role);
    assert.equal((await c.post(`/users/${other}/delete`, { confirm_username: 'viewer' })).status, 403, role);
  }
  assert.ok(second > 0);
});

test('HTTPS 운영 설정(SECURE_COOKIE)일 때만 HSTS 와 Secure 쿠키', async () => {
  const db2 = memDb();
  addUser(db2, 'admin');
  const app2 = createApp({ db: db2, secureCookie: true });
  const srv = app2.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    const page = await fetch(`${url}/login`);
    assert.equal(page.headers.get('strict-transport-security'), 'max-age=15552000');
    assert.ok(!/includeSubDomains/i.test(page.headers.get('strict-transport-security')));
    const login = await fetch(`${url}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: PASSWORD }) });
    assert.match(login.headers.get('set-cookie'), /; Secure/);
  } finally { srv.close(); }
  // 기본(개발) 설정에는 HSTS 가 없다
  assert.equal((await fetch(`${base}/login`)).headers.get('strict-transport-security'), null);
});
