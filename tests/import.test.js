import test from 'node:test';
import assert from 'node:assert/strict';
import { memDb, addProduct, ean } from './helpers.js';
import { importProducts, ValidationError } from '../src/lib/products.js';
import { importOrders, linkCodeToProduct, rematchOrders, listUnmatched, nextPendingLineForProduct, listOrders } from '../src/lib/orders.js';
import { applyStock, shipOrderLine, returnOrderLine, cancelPendingLine, StockError } from '../src/lib/inventory.js';

const qtyOf = (db, id) => db.prepare('SELECT qty, hold FROM inventory WHERE product_id = ?').get(id);

test('상품 가져오기: 신규·갱신·오류 보고, 초기 재고 원장', () => {
  const db = memDb();
  const csv = [
    '바코드,상품코드,상품명,옵션,분류,판매가,안전재고,재고관리,현재고',
    `${ean(1)},A-1,글러브,L,글러브,"89,000",5,Y,12`,
    `${ean(2)},A-2,배트,,배트,50000,0,N,`,
    `${ean(1)},A-9,중복 바코드,,,,,,`,
    `8.8E+12,A-3,엑셀 깨짐,,,,,,`,
    `${ean(4)},A-4,,,,,,,`,
    `${ean(5)},A-5,음수 재고,,,,,,-3`,
    '8800000000011,A-6,체크디지트 틀림,,,,,,',
  ].join('\r\n');
  const r = importProducts(db, csv);
  assert.equal(r.created, 3);
  assert.equal(r.skipped, 4);
  assert.equal(r.initialStock, 1);
  assert.equal(r.checkDigitWarnings, 1);
  assert.deepEqual(r.errors.map((e) => e.row), [4, 5, 6, 7]);
  const p1 = db.prepare('SELECT * FROM products WHERE barcode = ?').get(ean(1));
  assert.equal(p1.price, 89000);
  assert.equal(qtyOf(db, p1.id).qty, 12);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stock_ledger WHERE event_type = 'INIT'").get().n, 1);
  assert.equal(db.prepare('SELECT tracked FROM products WHERE barcode = ?').get(ean(2)).tracked, 0);
});

test('상품 가져오기: 다시 올리면 정보만 갱신하고 재고는 건드리지 않는다', () => {
  const db = memDb();
  const head = '바코드,상품명,현재고\n';
  importProducts(db, `${head}${ean(1)},이름1,10`);
  const r = importProducts(db, `${head}${ean(1)},이름2,999`);
  assert.equal(r.updated, 1);
  const p = db.prepare('SELECT id, name FROM products').get();
  assert.equal(p.name, '이름2');
  assert.equal(qtyOf(db, p.id).qty, 10);
});

test('상품 가져오기: 필수 열이 없으면 알려 준다', () => {
  const db = memDb();
  assert.throws(() => importProducts(db, '상품명\n가나다'), (e) => e instanceof ValidationError && /바코드/.test(e.message));
  assert.throws(() => importProducts(db, '바코드,상품명'), /데이터 행/);
});

test('상품 가져오기: 엄격 모드는 체크디지트가 틀린 행을 거부한다', () => {
  const db = memDb();
  const r = importProducts(db, '바코드,상품명\n8800000000011,틀림\n' + `${ean(2)},맞음`, { strict: true });
  assert.equal(r.created, 1);
  assert.equal(r.skipped, 1);
});

test('상품 10만 개 가져오기가 충분히 빠르다', () => {
  const db = memDb();
  const lines = ['바코드,상품코드,상품명,현재고'];
  for (let i = 1; i <= 100000; i++) lines.push(`${ean(i)},S${i},상품 ${i},${i % 7}`);
  const t0 = Date.now();
  const r = importProducts(db, lines.join('\n'));
  const ms = Date.now() - t0;
  assert.equal(r.created, 100000);
  assert.ok(ms < 30000, `10만 건 가져오기 ${ms}ms`);
  console.log(`  (10만 건 가져오기 ${ms}ms)`);
});

function setup() {
  const db = memDb();
  const p1 = addProduct(db, 1);
  const p2 = addProduct(db, 2);
  applyStock(db, { productId: p1, qtyDelta: 5, eventType: 'IN' });
  return { db, p1, p2 };
}

test('주문 가져오기: 상태 해석, 매칭, 개인정보 열 무시', () => {
  const { db, p1 } = setup();
  const csv = [
    '주문번호,주문상품번호,쇼핑몰,바코드,상품명,수량,주문상태,주문일시,수령인,연락처,주소',
    `N001,1,스마트스토어,${ean(1)},글러브,2,신규주문,2026-10-02 09:00,홍길동,010-1234-5678,서울시 어딘가`,
    `N002,1,쿠팡,${ean(1)},글러브,1,배송중,2026-10-01 09:00,김철수,010-0000-0000,부산`,
    `N003,1,쿠팡,${ean(1)},글러브,1,취소완료,2026-10-01 10:00,이영희,010-1111-1111,대구`,
    'N004,1,쿠팡,UNKNOWN-CODE,모르는 상품,3,결제완료,2026-10-02 11:00,박,010,인천',
    'N005,1,쿠팡,,,3,결제완료,,x,y,z',
  ].join('\n');
  const r = importOrders(db, csv);
  assert.equal(r.inserted, 4);
  assert.equal(r.pendingNew, 2);
  assert.equal(r.closedNew, 1);
  assert.equal(r.canceledNew, 1);
  assert.equal(r.unmatched, 1);
  assert.equal(r.errors.length, 1);
  const cols = db.prepare('PRAGMA table_info(order_lines)').all().map((c) => c.name).join(',');
  assert.ok(!/수령|연락|주소|buyer|phone|address/i.test(cols));
  const dump = JSON.stringify(db.prepare('SELECT * FROM order_lines').all());
  for (const secret of ['홍길동', '010-1234-5678', '서울시', '김철수']) assert.ok(!dump.includes(secret), `${secret} 저장 금지`);
  assert.equal(nextPendingLineForProduct(db, p1).order_no, 'N001');
});

test('주문 가져오기: 같은 파일을 다시 올려도 중복되지 않는다 (멱등)', () => {
  const { db } = setup();
  const csv = `주문번호,바코드,수량,상태\nN1,${ean(1)},1,신규\nN1,${ean(1)},1,신규\nN2,${ean(1)},2,신규`;
  const a = importOrders(db, csv);
  assert.equal(a.inserted, 3, '같은 주문의 같은 상품 두 줄도 따로 저장');
  const b = importOrders(db, csv);
  assert.equal(b.inserted, 0);
  assert.equal(b.duplicates, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_lines').get().n, 3);
});

test('주문 가져오기: 나중 파일의 취소·외부출고 반영, 출고 후 취소는 반품 필요 표시', () => {
  const { db, p1 } = setup();
  const head = '주문번호,주문상품번호,바코드,수량,주문상태\n';
  importOrders(db, `${head}A,1,${ean(1)},1,신규\nB,1,${ean(1)},1,신규\nC,1,${ean(1)},1,신규`);
  const idOf = (no) => db.prepare('SELECT id FROM order_lines WHERE order_no = ?').get(no).id;
  shipOrderLine(db, idOf('C'), null);
  const r = importOrders(db, `${head}A,1,${ean(1)},1,취소\nB,1,${ean(1)},1,배송중\nC,1,${ean(1)},1,반품요청`);
  assert.equal(r.canceledUpdated, 1);
  assert.equal(r.closedUpdated, 1);
  assert.equal(r.needsReturn, 1);
  const st = (no) => db.prepare('SELECT status, needs_return FROM order_lines WHERE order_no = ?').get(no);
  assert.equal(st('A').status, 'canceled');
  assert.equal(st('B').status, 'closed');
  assert.equal(st('C').needs_return, 1);
  assert.equal(listOrders(db, { status: 'needs_return' }).total, 1);
  assert.equal(qtyOf(db, p1).qty, 4, '취소·외부출고 표시는 재고를 바꾸지 않는다');
});

test('필수 열이 없는 주문 파일은 안내와 함께 거부', () => {
  const { db } = setup();
  assert.throws(() => importOrders(db, '번호,수량\n1,2'), (e) => e instanceof ValidationError && /주문번호/.test(e.message));
});

test('매칭 대기: 코드를 상품에 연결하면 기존·이후 주문이 모두 연결된다', () => {
  const { db, p2 } = setup();
  const csv = '주문번호,상품코드,상품명,수량\nX1,PA-777,외부코드 상품,1\nX2,PA-777,외부코드 상품,2';
  importOrders(db, csv);
  assert.equal(listUnmatched(db)[0].lines, 2);
  assert.equal(linkCodeToProduct(db, 'PA-777', p2), 2);
  assert.equal(listUnmatched(db).length, 0);
  const r = importOrders(db, 'a,b\n'.replace('a,b', '주문번호,상품코드,상품명,수량') + 'X3,PA-777,외부코드 상품,1');
  assert.equal(r.unmatched, 0, '다음 가져오기부터 자동 매칭');
});

test('상품을 나중에 등록하면 다시 매칭으로 연결된다', () => {
  const { db } = setup();
  importOrders(db, `주문번호,바코드,수량\nY1,${ean(50)},1`);
  assert.equal(listUnmatched(db).length, 1);
  addProduct(db, 50);
  assert.equal(rematchOrders(db), 1);
  assert.equal(listUnmatched(db).length, 0);
});

test('출고확정에서 처음 재고가 차감된다 / 재고 부족 시 거부', () => {
  const { db, p1, p2 } = setup();
  importOrders(db, `주문번호,바코드,수량\nO1,${ean(1)},4\nO2,${ean(1)},4\nO3,${ean(2)},1`);
  assert.equal(qtyOf(db, p1).qty, 5, '주문 접수만으로는 차감되지 않는다');
  const id = (no) => db.prepare('SELECT id FROM order_lines WHERE order_no = ?').get(no).id;
  shipOrderLine(db, id('O1'), 7);
  assert.equal(qtyOf(db, p1).qty, 1);
  assert.throws(() => shipOrderLine(db, id('O2'), 7), (e) => e instanceof StockError && e.code === 'INSUFFICIENT');
  assert.equal(db.prepare('SELECT status FROM order_lines WHERE id = ?').get(id('O2')).status, 'pending');
  assert.throws(() => shipOrderLine(db, id('O1'), 7), /이미 처리/);
  assert.throws(() => shipOrderLine(db, id('O3'), 7), StockError, '재고 0');
  assert.equal(p2 > 0, true);
});

test('출고 전 취소는 재고 무관, 반품은 양품/불량에 따라 들어간다', () => {
  const { db, p1 } = setup();
  importOrders(db, `주문번호,바코드,수량\nR1,${ean(1)},1\nR2,${ean(1)},2\nR3,${ean(1)},1`);
  const id = (no) => db.prepare('SELECT id FROM order_lines WHERE order_no = ?').get(no).id;
  cancelPendingLine(db, id('R1'));
  assert.equal(qtyOf(db, p1).qty, 5);
  assert.throws(() => cancelPendingLine(db, id('R1')), StockError);
  shipOrderLine(db, id('R2'), 1);
  shipOrderLine(db, id('R3'), 1);
  assert.equal(qtyOf(db, p1).qty, 2);
  returnOrderLine(db, id('R2'), { condition: 'good', userId: 1 });
  returnOrderLine(db, id('R3'), { condition: 'bad', userId: 1 });
  assert.deepEqual({ ...qtyOf(db, p1) }, { qty: 4, hold: 1 });
  assert.throws(() => returnOrderLine(db, id('R2'), { condition: 'good', userId: 1 }), /출고확정된 주문만/);
});
