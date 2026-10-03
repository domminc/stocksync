import test from 'node:test';
import assert from 'node:assert/strict';
import { memDb, addProduct, addUser, ean, PASSWORD } from './helpers.js';
import { applyStock } from '../src/lib/inventory.js';
import { deleteProducts, listProducts, findProductByCode, importProducts, suggestProducts } from '../src/lib/products.js';
import { importOrders } from '../src/lib/orders.js';
import { createApp } from '../src/app.js';

test('deleteProducts: 목록·검색·스캔에서 사라지고, 재고는 원장에 기록하며 0 으로, 바코드는 다시 쓸 수 있다', () => {
  const db = memDb();
  const id = addProduct(db, 1, { name: '삭제 테스트 글러브 ABC' });
  applyStock(db, { productId: id, qtyDelta: 7, eventType: 'IN', reason: 't' });
  applyStock(db, { productId: id, qtyDelta: 0, holdDelta: 2, eventType: 'RETURN_BAD', reason: 't' });
  const code = ean(1);
  assert.ok(findProductByCode(db, code));
  const r = deleteProducts(db, [id], null);
  assert.equal(r.done.length, 1);
  assert.equal(r.blocked.length, 0);
  // 숨겨진다
  assert.equal(listProducts(db, { q: '삭제 테스트' }).total, 0);
  assert.equal(listProducts(db, {}).total, 0);
  assert.ok(!findProductByCode(db, code), "삭제된 상품은 스캔으로 찾아지지 않는다");
  assert.equal(suggestProducts(db, ['ABC']).length, 0);
  // 재고는 0, 원장에는 정리 기록이 남고 이전 기록도 그대로
  assert.deepEqual({ ...db.prepare('SELECT qty, hold FROM inventory WHERE product_id = ?').get(id) }, { qty: 0, hold: 0 });
  const ledger = db.prepare('SELECT event_type, qty_delta, hold_delta, reason FROM stock_ledger WHERE product_id = ? ORDER BY id').all(id);
  assert.equal(ledger.length, 3);
  assert.deepEqual({ ...ledger[2] }, { event_type: 'ADJUST', qty_delta: -7, hold_delta: -2, reason: '상품 삭제 — 남은 재고를 0으로 정리' });
  assert.ok(db.prepare('SELECT deleted_at FROM products WHERE id = ?').get(id).deleted_at);
  // 같은 바코드·상품코드로 새 상품을 만들 수 있다
  const again = importProducts(db, `바코드,상품코드,상품명\n${code},SKU-1,삭제 테스트 글러브 ABC\n`);
  assert.equal(again.created, 1);
  assert.equal(listProducts(db, {}).total, 1);
  // 이미 삭제된 것을 또 삭제하면 막힌다
  assert.equal(deleteProducts(db, [id]).blocked.length, 1);
});

test('deleteProducts: 미출고 주문이 있으면 막고, 다른 상품은 계속 삭제한다 / 진행 중 스캔 줄·별칭 정리', () => {
  const db = memDb();
  const busy = addProduct(db, 2, { name: '주문 걸린 상품' });
  const free = addProduct(db, 3, { name: '자유 상품' });
  importOrders(db, `주문번호,주문상품번호,쇼핑몰,바코드,상품명,수량,주문상태\nD-1,1,쿠팡,${ean(2)},주문 걸린 상품,1,신규주문\n`);
  db.prepare("INSERT INTO users (username, display_name, password_hash, role, active, created_at, updated_at) VALUES ('u','u','x','staff',1,'','')").run();
  const sid = db.prepare("INSERT INTO scan_sessions (user_id, mode, status, created_at) VALUES (1, 'in', 'open', '')").run().lastInsertRowid;
  db.prepare('INSERT INTO scan_lines (session_id, product_id, qty) VALUES (?, ?, 3)').run(sid, free);
  db.prepare("INSERT INTO code_aliases (raw_code, product_id, created_at) VALUES ('NAME:자유', ?, '')").run(free);
  const r = deleteProducts(db, [busy, free], null);
  assert.deepEqual(r.done.map((d) => d.id), [free]);
  assert.equal(r.blocked.length, 1);
  assert.match(r.blocked[0].reason, /미출고 주문 1건/);
  assert.ok(!db.prepare('SELECT deleted_at FROM products WHERE id = ?').get(busy).deleted_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_lines WHERE product_id = ?').get(free).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_aliases WHERE product_id = ?').get(free).n, 0);
});

test('HTTP: 삭제는 관리자만, 상세는 “삭제” 입력 확인, 선택 삭제', async () => {
  const db = memDb();
  addUser(db, 'admin'); addUser(db, 'manager');
  const a = addProduct(db, 11, { name: '화면 삭제 A' });
  const b = addProduct(db, 12, { name: '화면 삭제 B' });
  const c = addProduct(db, 13, { name: '화면 삭제 C' });
  const server = createApp({ db }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u) => {
    const res = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: u, password: PASSWORD, next: '/' }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(`${base}/password`, { headers: { cookie } })).text();
    return { cookie, csrf: /name="_csrf" value="([^"]+)"/.exec(html)[1] };
  };
  const post = (s, path, body) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body });
  const flash = (r) => decodeURIComponent((r.headers.get('location') ?? '').match(/msg=([^&]*)/)?.[1] ?? '');
  const gone = (id) => Boolean(db.prepare('SELECT deleted_at FROM products WHERE id = ?').get(id).deleted_at);
  try {
    const admin = await login('admin');
    const manager = await login('manager');
    assert.equal((await post(manager, `/products/${a}/delete`, `_csrf=${manager.csrf}&confirm=삭제`)).status, 403, '매니저는 삭제 불가');
    assert.equal((await post(manager, '/products/delete-selected', `_csrf=${manager.csrf}&ids=${a}`)).status, 403);
    assert.equal((await post(admin, `/products/${a}/delete`, `confirm=삭제`)).status, 403, 'CSRF');
    let r = await post(admin, `/products/${a}/delete`, `_csrf=${admin.csrf}&confirm=네`);
    assert.match(flash(r), /“삭제”를 입력/);
    assert.ok(!gone(a));
    r = await post(admin, `/products/${a}/delete`, `_csrf=${admin.csrf}&confirm=삭제`);
    assert.match(flash(r), /상품을 삭제했습니다/);
    assert.ok(gone(a));
    r = await post(admin, '/products/delete-selected', `_csrf=${admin.csrf}&ids=${b}&ids=${c}&return_to=/products`);
    assert.match(flash(r), /상품 2개를 삭제했습니다/);
    assert.ok(gone(b) && gone(c));
    r = await post(admin, '/products/delete-selected', `_csrf=${admin.csrf}`);
    assert.match(flash(r), /먼저 체크/);
    // 화면: 관리자 목록에는 삭제 버튼, 매니저에게는 없음. 삭제된 상품 상세는 “삭제됨”
    const d = await (await fetch(`${base}/products/${a}`, { headers: { cookie: admin.cookie } })).text();
    assert.match(d, /삭제됨/);
    assert.doesNotMatch(d, /action="\/products\/\d+\/delete"/);
    const alive = addProduct(db, 14, { name: '화면 삭제 D' });
    const list = await (await fetch(`${base}/products`, { headers: { cookie: admin.cookie } })).text();
    assert.match(list, /formaction="\/products\/delete-selected"/);
    assert.ok(!list.includes('화면 삭제 A'));
    const mlist = await (await fetch(`${base}/products`, { headers: { cookie: manager.cookie } })).text();
    assert.doesNotMatch(mlist, /delete-selected/);
    const det = await (await fetch(`${base}/products/${alive}`, { headers: { cookie: admin.cookie } })).text();
    assert.match(det, /action="\/products\/\d+\/delete"/);
    const mdet = await (await fetch(`${base}/products/${alive}`, { headers: { cookie: manager.cookie } })).text();
    assert.doesNotMatch(mdet, /\/delete"/);
  } finally {
    server.close();
  }
});
