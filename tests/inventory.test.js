import test from 'node:test';
import assert from 'node:assert/strict';
import { memDb, addProduct, ean } from './helpers.js';
import { applyStock, applyBatch, findShortages, adjustTo, resolveHold, StockError } from '../src/lib/inventory.js';
import { createProduct, updateProduct, listProducts, ValidationError } from '../src/lib/products.js';

const inv = (db, id) => db.prepare('SELECT qty, hold FROM inventory WHERE product_id = ?').get(id);
const ledgerCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM stock_ledger').get().n;

test('입고·출고가 수량과 원장에 반영된다', () => {
  const db = memDb();
  const id = addProduct(db, 1);
  applyStock(db, { productId: id, qtyDelta: 10, eventType: 'IN' });
  applyStock(db, { productId: id, qtyDelta: -3, eventType: 'OUT' });
  assert.deepEqual({ ...inv(db, id) }, { qty: 7, hold: 0 });
  const rows = db.prepare('SELECT event_type, qty_delta, qty_after FROM stock_ledger ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.event_type, r.qty_delta, r.qty_after]), [['IN', 10, 10], ['OUT', -3, 7]]);
});

test('재고보다 많이 출고하면 거부되고 아무것도 바뀌지 않는다', () => {
  const db = memDb();
  const id = addProduct(db, 1);
  applyStock(db, { productId: id, qtyDelta: 2, eventType: 'IN' });
  assert.throws(() => applyStock(db, { productId: id, qtyDelta: -3, eventType: 'OUT' }), (e) => e instanceof StockError && e.code === 'INSUFFICIENT');
  assert.equal(inv(db, id).qty, 2);
  assert.equal(ledgerCount(db), 1);
});

test('여러 건 중 하나라도 부족하면 전체가 취소된다 (all-or-nothing)', () => {
  const db = memDb();
  const a = addProduct(db, 1);
  const b = addProduct(db, 2);
  applyStock(db, { productId: a, qtyDelta: 5, eventType: 'IN' });
  applyStock(db, { productId: b, qtyDelta: 1, eventType: 'IN' });
  const before = ledgerCount(db);
  assert.throws(() => applyBatch(db, [{ productId: a, qtyDelta: -2 }, { productId: b, qtyDelta: -2 }], { eventType: 'OUT' }), StockError);
  assert.equal(inv(db, a).qty, 5, '앞 건도 되돌려져야 한다');
  assert.equal(ledgerCount(db), before);
  assert.deepEqual(findShortages(db, [{ productId: a, qty: 2 }, { productId: b, qty: 2 }]).map((s) => s.productId), [b]);
});

test('재고 원장은 수정·삭제할 수 없다', () => {
  const db = memDb();
  const id = addProduct(db, 1);
  applyStock(db, { productId: id, qtyDelta: 1, eventType: 'IN' });
  assert.throws(() => db.prepare('UPDATE stock_ledger SET qty_delta = 99').run(), /수정할 수 없습니다/);
  assert.throws(() => db.prepare('DELETE FROM stock_ledger').run(), /삭제할 수 없습니다/);
});

test('재고 관리 대상이 아닌 상품은 재고를 바꿀 수 없다', () => {
  const db = memDb();
  const id = addProduct(db, 1, { tracked: false });
  assert.throws(() => applyStock(db, { productId: id, qtyDelta: 1, eventType: 'IN' }), (e) => e.code === 'NOT_TRACKED');
});

test('재고 조정: 실사 수량에 맞추고 사유가 필수', () => {
  const db = memDb();
  const id = addProduct(db, 1);
  applyStock(db, { productId: id, qtyDelta: 10, eventType: 'IN' });
  assert.throws(() => adjustTo(db, { productId: id, counted: 8, reason: ' ' }), StockError);
  const r = adjustTo(db, { productId: id, counted: 8, reason: '파손 2개' });
  assert.deepEqual({ ...r }, { changed: true, delta: -2 });
  assert.equal(inv(db, id).qty, 8);
  assert.equal(adjustTo(db, { productId: id, counted: 8, reason: '확인' }).changed, false);
});

test('보류 재고: 해제하면 가용으로, 폐기하면 사라진다', () => {
  const db = memDb();
  const id = addProduct(db, 1);
  applyStock(db, { productId: id, holdDelta: 5, eventType: 'RETURN_BAD' });
  resolveHold(db, { productId: id, qty: 2, action: 'release' });
  assert.deepEqual({ ...inv(db, id) }, { qty: 2, hold: 3 });
  resolveHold(db, { productId: id, qty: 3, action: 'discard' });
  assert.deepEqual({ ...inv(db, id) }, { qty: 2, hold: 0 });
  assert.throws(() => resolveHold(db, { productId: id, qty: 1, action: 'discard' }), (e) => e.code === 'INSUFFICIENT_HOLD');
});

test('상품 등록 검증: 중복 바코드, 지수 표기, 형식', () => {
  const db = memDb();
  addProduct(db, 1);
  assert.throws(() => createProduct(db, { barcode: ean(1), name: '중복' }), (e) => e instanceof ValidationError && /이미 등록된 바코드/.test(e.message));
  assert.throws(() => createProduct(db, { barcode: '8.80001E+12', name: 'x' }), /지수 표기/);
  assert.throws(() => createProduct(db, { barcode: 'ab', name: 'x' }), /형식/);
  assert.throws(() => createProduct(db, { barcode: ean(2), name: ' ' }), /상품명/);
  assert.throws(() => createProduct(db, { barcode: '8800000000011', name: 'x' }, { strict: true }), /체크디지트/);
  const id = createProduct(db, { barcode: ean(3), name: '수정 전' });
  updateProduct(db, id, { barcode: ean(3), skuCode: 'NEW', name: '수정 후', safetyStock: 3 });
  assert.equal(db.prepare('SELECT name, sku_code, safety_stock FROM products WHERE id = ?').get(id).name, '수정 후');
});

test('상품 검색: 바코드 정확 일치, 이름 부분 일치, 필터, 페이지', () => {
  const db = memDb();
  for (let i = 1; i <= 120; i++) addProduct(db, i, { name: i % 2 ? `글러브 ${i}` : `배트 ${i}`, safetyStock: 5 });
  assert.equal(listProducts(db, { q: ean(7) }).total, 1);
  assert.equal(listProducts(db, { q: '글러브' }).total, 60);
  assert.equal(listProducts(db, {}).pages, 3);
  assert.equal(listProducts(db, { page: 99 }).page, 3);
  assert.equal(listProducts(db, { filter: 'out' }).total, 120);
  applyStock(db, { productId: 1, qtyDelta: 3, eventType: 'IN' });
  assert.equal(listProducts(db, { filter: 'low' }).total, 1);
  assert.equal(listProducts(db, { q: '%' }).total, 0, 'LIKE 특수문자는 문자 그대로 검색');
});
