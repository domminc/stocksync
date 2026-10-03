import test from 'node:test';
import assert from 'node:assert/strict';
import { memDb, addProduct, addUser, PASSWORD } from './helpers.js';
import { setSafetyStock, setSafetyStockMany, parseSafetyStock, ValidationError } from '../src/lib/products.js';
import { createApp } from '../src/app.js';

test('안전재고 값 검사: 0 이상 정수만', () => {
  assert.equal(parseSafetyStock('0'), 0);
  assert.equal(parseSafetyStock(' 12 '), 12);
  for (const bad of ['', '-1', '1.5', 'abc', '1000001', '99999999']) assert.throws(() => parseSafetyStock(bad), ValidationError, bad);
});

test('setSafetyStock: 한 상품만 바꾼다 / 없는 상품은 null', () => {
  const db = memDb();
  const a = addProduct(db, 1);
  const b = addProduct(db, 2);
  assert.equal(setSafetyStock(db, a, '7'), 7);
  assert.equal(db.prepare('SELECT safety_stock FROM products WHERE id = ?').get(a).safety_stock, 7);
  assert.equal(db.prepare('SELECT safety_stock FROM products WHERE id = ?').get(b).safety_stock, 0);
  assert.equal(setSafetyStock(db, 9999, '3'), null);
});

test('setSafetyStockMany: 검색 조건에 맞는 상품만 일괄 변경', () => {
  const db = memDb();
  addProduct(db, 1, { name: '글러브 A' });
  addProduct(db, 2, { name: '글러브 B' });
  addProduct(db, 3, { name: '배트 C' });
  const r = setSafetyStockMany(db, { q: '글러브' }, '4');
  assert.equal(r.count, 2);
  const rows = db.prepare('SELECT name, safety_stock FROM products ORDER BY id').all();
  assert.deepEqual(rows.map((x) => x.safety_stock), [4, 4, 0]);
  assert.throws(() => setSafetyStockMany(db, {}, '-3'), ValidationError);
});

test('HTTP: 상세 저장·일괄 적용·권한·CSRF', async () => {
  const db = memDb();
  addUser(db, 'admin'); addUser(db, 'viewer');
  const id = addProduct(db, 5, { name: '권한 테스트 글러브' });
  const server = createApp({ db }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u) => {
    const res = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: u, password: PASSWORD, next: '/' }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(`${base}/password`, { headers: { cookie } })).text();
    return { cookie, csrf: /name="_csrf" value="([^"]+)"/.exec(html)[1] };
  };
  const post = (s, path, data) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  const flash = (r) => decodeURIComponent((r.headers.get('location') ?? '').match(/msg=([^&]*)/)?.[1] ?? '');
  const val = () => db.prepare('SELECT safety_stock FROM products WHERE id = ?').get(id).safety_stock;
  try {
    const admin = await login('admin');
    const viewer = await login('viewer');
    assert.equal((await post(viewer, `/products/${id}/safety`, { _csrf: viewer.csrf, safety_stock: '9' })).status, 403);
    assert.equal((await post(admin, `/products/${id}/safety`, { safety_stock: '9' })).status, 403, 'CSRF');
    let r = await post(admin, `/products/${id}/safety`, { _csrf: admin.csrf, safety_stock: '6' });
    assert.match(flash(r), /6개로 바꿨습니다/);
    assert.equal(val(), 6);
    r = await post(admin, `/products/${id}/safety`, { _csrf: admin.csrf, safety_stock: 'x' });
    assert.match(flash(r), /숫자여야/);
    assert.equal(val(), 6);
    r = await post(admin, '/products/safety-bulk', { _csrf: admin.csrf, q: '권한 테스트', filter: '', safety_stock: '11' });
    assert.match(flash(r), /1개의 안전재고를 11개로/);
    assert.equal(val(), 11);
    const detail = await (await fetch(`${base}/products/${id}`, { headers: { cookie: admin.cookie } })).text();
    assert.match(detail, /action="\/products\/\d+\/safety"/);
    const list = await (await fetch(`${base}/products`, { headers: { cookie: admin.cookie } })).text();
    assert.match(list, /검색 결과 전체에 일괄 적용/);
    assert.match(list, /action="\/products\/bulk-selected"/);
    assert.match(list, /name="ids" value="\d+" form="psel"/);
    const vlist = await (await fetch(`${base}/products`, { headers: { cookie: viewer.cookie } })).text();
    assert.doesNotMatch(vlist, /검색 결과 전체에 일괄 적용/);
    assert.doesNotMatch(vlist, /bulk-selected/);
    // 체크한 상품들에 적용: 안전재고 / 사용 중지 / 다시 사용
    let rr = await post(admin, '/products/bulk-selected', { _csrf: admin.csrf, action: 'safety', safety_stock: '8', ids: String(id) });
    assert.match(flash(rr), /1개의 안전재고를 8개로/);
    assert.equal(val(), 8);
    rr = await post(admin, '/products/bulk-selected', { _csrf: admin.csrf, action: 'deactivate', ids: String(id) });
    assert.match(flash(rr), /1개를 사용 중지/);
    assert.equal(db.prepare('SELECT active FROM products WHERE id = ?').get(id).active, 0);
    rr = await post(admin, '/products/bulk-selected', { _csrf: admin.csrf, action: 'activate', ids: String(id) });
    assert.equal(db.prepare('SELECT active FROM products WHERE id = ?').get(id).active, 1);
    rr = await post(admin, '/products/bulk-selected', { _csrf: admin.csrf, action: 'safety', safety_stock: '8' });
    assert.match(flash(rr), /먼저 체크/);
    assert.equal((await post(viewer, '/products/bulk-selected', { _csrf: viewer.csrf, action: 'deactivate', ids: String(id) })).status, 403);
  } finally {
    server.close();
  }
});

test('setActiveMany: 조건에 맞는 상품만 사용 중지/재사용', async () => {
  const { setActiveMany } = await import('../src/lib/products.js');
  const db = memDb();
  addProduct(db, 1, { name: '[샘플] 글러브' });
  addProduct(db, 2, { name: '[샘플] 배트' });
  addProduct(db, 3, { name: '진짜 글러브' });
  assert.equal(setActiveMany(db, { q: '[샘플]' }, false).count, 2);
  assert.deepEqual(db.prepare('SELECT active FROM products ORDER BY id').all().map((r) => r.active), [0, 0, 1]);
  assert.equal(setActiveMany(db, { q: '[샘플]' }, true).count, 2);
  assert.deepEqual(db.prepare('SELECT active FROM products ORDER BY id').all().map((r) => r.active), [1, 1, 1]);
});
