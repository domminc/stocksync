import test from 'node:test';
import assert from 'node:assert/strict';
import { memDb, addProduct, ean } from './helpers.js';
import { applyStock, shipMany } from '../src/lib/inventory.js';
import { importOrders, shippableLineIds } from '../src/lib/orders.js';

function setup() {
  const db = memDb();
  const id = addProduct(db, 901, { name: '일괄 테스트 글러브' });
  applyStock(db, { productId: id, qtyDelta: 5, eventType: 'IN', reason: 't' });
  const rows = ['주문번호,주문상품번호,쇼핑몰,바코드,상품명,수량,주문상태'];
  for (let i = 1; i <= 8; i++) rows.push(`B-${i},1,쿠팡,${ean(901)},일괄 테스트 글러브,1,신규주문`);
  rows.push('B-X,1,쿠팡,UNKNOWN-CODE,연결 안 된 상품,1,신규주문');
  importOrders(db, rows.join('\n'));
  return { db, id };
}

test('shippableLineIds: 상품이 연결된 미출고 주문만, 오래된 순서로', () => {
  const { db } = setup();
  const ids = shippableLineIds(db);
  assert.equal(ids.length, 8);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(shippableLineIds(db, { q: 'B-3' }).length, 1);
  assert.equal(shippableLineIds(db, { limit: 3 }).length, 3);
});

test('shipMany: 재고가 모자라면 오래된 주문부터 출고하고 나머지는 건너뛴다(전체 롤백 없음)', () => {
  const { db, id: pid } = setup();
  const ids = shippableLineIds(db);
  const r = shipMany(db, ids, null);
  assert.equal(r.done.length, 5);
  assert.equal(r.failed.length, 3);
  assert.deepEqual(r.done.map((d) => d.orderNo), ['B-1', 'B-2', 'B-3', 'B-4', 'B-5']);
  assert.equal(db.prepare('SELECT qty FROM inventory WHERE product_id = ?').get(pid).qty, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_lines WHERE status = 'shipped'").get().n, 5);
  // 같은 줄을 다시 보내도 이중 차감되지 않는다
  const again = shipMany(db, ids, null);
  assert.equal(again.done.length, 0);
  assert.equal(db.prepare('SELECT qty FROM inventory WHERE product_id = ?').get(pid).qty, 0);
});

// ---- HTTP 수준: 권한·CSRF·선택/전체 모드, 테마 쿠키
import { addUser, PASSWORD } from './helpers.js';
import { createApp } from '../src/app.js';

test('POST /orders/ship-bulk: 선택 모드·전체 모드·권한·CSRF', async () => {
  const { db, id: pid } = setup();
  addUser(db, 'admin');
  addUser(db, 'viewer');
  const server = createApp({ db }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u) => {
    const res = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: u, password: PASSWORD, next: '/' }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(`${base}/password`, { headers: { cookie } })).text();
    return { cookie, csrf: /name="_csrf" value="([^"]+)"/.exec(html)[1] };
  };
  const post = (s, data) => fetch(`${base}/orders/ship-bulk`, { method: 'POST', redirect: 'manual', headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  const flash = (res) => decodeURIComponent((res.headers.get('location') ?? '').match(/msg=([^&]*)/)?.[1] ?? '');
  try {
    const admin = await login('admin');
    const viewer = await login('viewer');
    assert.equal((await post(viewer, { _csrf: viewer.csrf, mode: 'all' })).status, 403, '조회 전용은 불가');
    assert.equal((await post(admin, { mode: 'all' })).status, 403, 'CSRF 토큰 필요');
    let r = await post(admin, { _csrf: admin.csrf, mode: 'selected' });
    assert.match(flash(r), /출고확정할 주문이 없습니다/);
    const ids = shippableLineIds(db).slice(0, 2);
    r = await fetch(`${base}/orders/ship-bulk`, { method: 'POST', redirect: 'manual', headers: { cookie: admin.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: `_csrf=${admin.csrf}&mode=selected&ids=${ids[0]}&ids=${ids[1]}` });
    assert.match(flash(r), /2건 출고확정/);
    r = await post(admin, { _csrf: admin.csrf, mode: 'all' });
    assert.match(flash(r), /3건 출고확정했습니다\. 3건은 건너뛰었습니다/); // 재고 5개 → 나머지 3개 처리, 3건은 부족
    assert.equal(db.prepare('SELECT qty FROM inventory WHERE product_id = ?').get(pid).qty, 0);
    const page = await (await fetch(`${base}/orders?status=pending`, { headers: { cookie: admin.cookie } })).text();
    assert.match(page, /id="bulk"/);
    // 테마 쿠키가 있으면 html 에 data-theme 이 붙는다
    const dark = await (await fetch(`${base}/login`, { headers: { cookie: 'theme=dark' } })).text();
    assert.match(dark, /<html lang="ko" data-theme="dark">/);
    const sys = await (await fetch(`${base}/login`)).text();
    assert.match(sys, /<html lang="ko">/);
  } finally {
    server.close();
  }
});
