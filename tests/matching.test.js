import test from 'node:test';
import assert from 'node:assert/strict';
import { memDb, addProduct, ean } from './helpers.js';
import { makeNameKey, normalizeName, normalizeOption, splitOrderItemName, isAddonLine, searchTokens } from '../src/lib/namekey.js';
import { createProduct, importProducts, labelTargets, markLabelsPrinted, suggestProducts, backfillNameKeys } from '../src/lib/products.js';
import { importOrders, listUnmatched, linkMatchKeyToProduct, ignoreMatchKey, rematchOrders } from '../src/lib/orders.js';

test('상품명 정규화: 말머리·공백·기호·대소문자 무시', () => {
  assert.equal(normalizeName('[오늘출발]롤링스 내야글러브 N65-4V'), normalizeName('롤링스  내야글러브  n65 4v'));
  assert.notEqual(normalizeName('미즈노 프로 31001'), normalizeName('미즈노 프로 31002'));
});

test('옵션 정규화: 이름표 제거, 순서 무관, 단일상품은 옵션 없음', () => {
  assert.equal(normalizeOption('색상: 블루'), normalizeOption('블루'));
  assert.equal(normalizeOption('사이즈: M / 색상: 블랙'), normalizeOption('색상=블랙 / 사이즈=M'));
  assert.equal(normalizeOption('단일상품'), '');
  assert.equal(normalizeOption('기본'), '');
  assert.notEqual(normalizeOption('사이즈: M'), normalizeOption('사이즈: L'));
});

test('주문 문구 나누기, 추가상품 판별, 검색 단어', () => {
  assert.deepEqual(splitOrderItemName('A 상품 / 색상: 블루 / 사이즈: M'), { name: 'A 상품', option: '색상: 블루 / 사이즈: M' });
  assert.deepEqual(splitOrderItemName('옵션 없는 상품'), { name: '옵션 없는 상품', option: '' });
  assert.ok(isAddonLine('┗(추가상품)[오늘출발]배송메세지에 기입 / 자수 신청: 배송메세지에 기입'));
  assert.ok(!isAddonLine('미즈노 프로 수비장갑 / 사이즈: L'));
  assert.equal(searchTokens('미즈노 프로 수비장갑 야구장갑 31001 우투 화이트골드')[0], '31001', '모델 번호를 먼저');
});

test('코드 없는 주문 파일: 상품명+옵션으로 자동 매칭 (말머리·이름표 차이 허용)', () => {
  const db = memDb();
  const id = createProduct(db, { name: '미즈노 프로 수비장갑 야구장갑 31001 우투 화이트골드', optionName: '사이즈: L(25cm)' });
  createProduct(db, { name: '미즈노 프로 수비장갑 야구장갑 31001 우투 화이트골드', optionName: '사이즈: M(24cm)' });
  const csv = [
    '주문번호,쇼핑몰,상품명,수량,주문상태',
    'A1,스마트스토어,[오늘출발]미즈노 프로 수비장갑 야구장갑 31001 우투 화이트골드 / 사이즈: L(25cm),1,신규주문',
    'A2,쿠팡,미즈노 프로 수비장갑 야구장갑 31001 우투 화이트골드 / L(25cm),1,신규주문',
    'A3,쿠팡,미즈노 프로 수비장갑 야구장갑 31001 우투 화이트골드 / 사이즈: XL,1,신규주문',
  ].join('\n');
  const r = importOrders(db, csv);
  assert.equal(r.matchedByName, 2);
  assert.equal(r.unmatched, 1);
  const pid = (no) => db.prepare('SELECT product_id FROM order_lines WHERE order_no = ?').get(no).product_id;
  assert.equal(pid('A1'), id);
  assert.equal(pid('A2'), id);
  assert.equal(pid('A3'), null);
});

test('같은 이름+옵션 상품이 둘이면 임의로 고르지 않고 매칭 대기로 보낸다', () => {
  const db = memDb();
  createProduct(db, { name: '똑같은 상품', optionName: 'M', skuCode: 'X1' });
  createProduct(db, { name: '똑같은 상품', optionName: 'M', skuCode: 'X2' });
  const r = importOrders(db, '주문번호,상품명,수량\nD1,똑같은 상품 / M,1');
  assert.equal(r.unmatched, 1);
  assert.equal(r.matchedByName, 0);
});

test('추가상품(┗)은 자동 제외, 상품과 매칭되면 제외하지 않는다', () => {
  const db = memDb();
  const csv = '주문번호,상품명,수량\nE1,┗(추가상품)[오늘출발]1. 고딕체 / 레이저 각인 신청: 1. 고딕체,1\nE2,어딘가 없는 상품 / M,1';
  const r = importOrders(db, csv);
  assert.equal(r.addonsIgnored, 1);
  assert.equal(r.unmatched, 1);
  assert.equal(db.prepare("SELECT status FROM order_lines WHERE order_no = 'E1'").get().status, 'closed');
  assert.equal(listUnmatched(db).length, 1);
});

test('매칭 대기 → 후보 제안(모델 번호) → 한 번 연결하면 다음 가져오기부터 자동', () => {
  const db = memDb();
  const target = createProduct(db, { name: '롤링스 나무배트 빅스틱 BHW5WC-NAT/B 블랙', optionName: '33.5in' });
  createProduct(db, { name: '전혀 다른 글러브', optionName: '' });
  importOrders(db, '주문번호,상품명,수량\nF1,[오늘출발]롤링스 나무배트 빅스틱 우드 콤포짓 배트 BHW5WC-NAT/B 블랙 / 사이즈: 33.5in (85cm),2');
  const [row] = listUnmatched(db, { suggest: 5 });
  assert.ok(row.match_key.startsWith('NAME:'));
  assert.equal(row.suggestions[0].id, target, '모델 번호가 같은 상품이 첫 후보');
  assert.equal(linkMatchKeyToProduct(db, row.match_key, target), 1);
  assert.equal(listUnmatched(db).length, 0);

  const again = importOrders(db, '주문번호,상품명,수량\nF2,[오늘출발]롤링스 나무배트 빅스틱 우드 콤포짓 배트 BHW5WC-NAT/B 블랙 / 사이즈: 33.5in (85cm),1');
  assert.equal(again.unmatched, 0);
  assert.equal(again.matchedByName, 1);
});

test('무시 처리: 지금 줄은 닫히고, 이후 같은 항목은 자동 제외', () => {
  const db = memDb();
  importOrders(db, '주문번호,상품명,수량\nG1,배송메세지 확인용 서비스 / 선택: 예,1');
  const [row] = listUnmatched(db);
  assert.equal(ignoreMatchKey(db, row.match_key), 1);
  assert.equal(listUnmatched(db).length, 0);
  const r = importOrders(db, '주문번호,상품명,수량\nG2,배송메세지 확인용 서비스 / 선택: 예,1');
  assert.equal(r.addonsIgnored, 1);
  assert.equal(r.unmatched, 0);
});

test('상품을 나중에 등록하면 다시 매칭(상품명 기준)으로 연결된다', () => {
  const db = memDb();
  importOrders(db, '주문번호,상품명,수량\nH1,나중에 등록할 상품 / 색상: 레드,1');
  assert.equal(listUnmatched(db).length, 1);
  createProduct(db, { name: '나중에 등록할 상품', optionName: '레드' });
  assert.equal(rematchOrders(db), 1);
  assert.equal(listUnmatched(db).length, 0);
});

test('상품 가져오기: 바코드 열이 없으면 자동 발급하고, 다시 올려도 새로 발급하지 않는다', () => {
  const db = memDb();
  const csv = '판매자관리코드,상품명,옵션\nGLV-1-RD-L,글러브,빨강/L\nGLV-1-BK-L,글러브,검정/L\n,배트,33in\n,배트,34in';
  const r = importProducts(db, csv);
  assert.equal(r.created, 4);
  assert.equal(r.barcodesIssued, 4);
  const before = db.prepare('SELECT sku_code, barcode FROM products ORDER BY id').all().map((x) => `${x.sku_code}=${x.barcode}`);
  assert.ok(before.every((b) => /=20\d{11}$/.test(b)));
  const again = importProducts(db, csv);
  assert.equal(again.created, 0);
  assert.equal(again.updated, 4);
  assert.equal(again.barcodesIssued, 0);
  const after = db.prepare('SELECT sku_code, barcode FROM products ORDER BY id').all().map((x) => `${x.sku_code}=${x.barcode}`);
  assert.deepEqual(after, before, '바코드가 바뀌면 안 된다');
});

test('상품 가져오기: 코드 없이 같은 상품명+옵션이 반복되면 구분할 수 없어 알려 준다', () => {
  const db = memDb();
  const r = importProducts(db, '상품명,옵션\n같은 상품,M\n같은 상품,M\n다른 상품,M');
  assert.equal(r.created, 2);
  assert.equal(r.skipped, 1);
  assert.match(r.errors[0].message, /중복/);
});

test('상품 가져오기: 바코드가 있는 행과 없는 행을 섞어도 된다', () => {
  const db = memDb();
  const r = importProducts(db, `바코드,상품코드,상품명\n${ean(1)},A-1,있음\n,A-2,없음`);
  assert.equal(r.created, 2);
  assert.equal(r.barcodesIssued, 1);
  assert.equal(db.prepare("SELECT barcode FROM products WHERE sku_code = 'A-1'").get().barcode, ean(1));
});

test('라벨 대상: 미출력만 골라 출력 표시', () => {
  const db = memDb();
  const ids = [1, 2, 3].map((n) => addProduct(db, n));
  assert.equal(labelTargets(db, { filter: 'unprinted' }).length, 3);
  assert.equal(markLabelsPrinted(db, [ids[0], ids[1]]), 2);
  assert.deepEqual(labelTargets(db, { filter: 'unprinted' }).map((p) => p.id), [ids[2]]);
  assert.deepEqual(labelTargets(db, { ids: [ids[0]] }).map((p) => p.id), [ids[0]]);
});

test('후보 검색(FTS): 상품 이름을 바꾸면 색인도 갱신된다', () => {
  const db = memDb();
  const id = createProduct(db, { name: '오래된이름 모델 ZZ99' });
  assert.equal(suggestProducts(db, ['zz99'])[0]?.id, id);
  db.prepare("UPDATE products SET name = '새이름 모델 QQ11' WHERE id = ?").run(id);
  assert.equal(suggestProducts(db, ['zz99']).length, 0);
  assert.equal(suggestProducts(db, ['qq11'])[0]?.id, id);
  assert.deepEqual(suggestProducts(db, []), []);
  assert.deepEqual(suggestProducts(db, ['"; DROP TABLE products; --']), [], '특수문자 입력도 안전');
});

test('시작 시 이름 키 채우기', () => {
  const db = memDb();
  const id = addProduct(db, 1, { name: '키 없는 상품', optionName: '옵션' });
  db.prepare("UPDATE products SET name_key = '' WHERE id = ?").run(id);
  assert.equal(backfillNameKeys(db), 1);
  assert.equal(db.prepare('SELECT name_key FROM products WHERE id = ?').get(id).name_key, makeNameKey('키 없는 상품', '옵션'));
  assert.equal(backfillNameKeys(db), 0);
});
