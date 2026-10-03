import test from 'node:test';
import assert from 'node:assert/strict';
import { memDb, addProduct } from './helpers.js';
import { issueBarcode, ean13Bits, ean13Svg, C128_PATTERNS, code128Values, code128Bits, code128Svg, barcodeSvg } from '../src/lib/barcodes.js';
import { isValidEan13, ean13CheckDigit } from '../src/lib/ean13.js';
import { createProduct } from '../src/lib/products.js';

test('자체 바코드: 77 접두 + 일련번호 + 올바른 체크디지트, 번호는 겹치지 않는다', () => {
  const db = memDb();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const code = issueBarcode(db);
    assert.match(code, /^77\d{11}$/);
    assert.ok(isValidEan13(code), code);
    assert.ok(!seen.has(code));
    seen.add(code);
    db.prepare("INSERT INTO products (sku_code, barcode, name, created_at, updated_at) VALUES (?, ?, 'x', '', '')").run(`S${i}`, code);
  }
});

test('이미 쓰는 번호는 건너뛰고 발급한다 (일련번호는 되돌아가지 않음)', () => {
  const db = memDb();
  const first = issueBarcode(db);
  // 다음 일련번호(2)가 이미 외부 바코드로 등록되어 있는 경우
  const next12 = `77${String(2).padStart(10, '0')}`;
  const taken = next12 + ean13CheckDigit(next12);
  db.prepare("INSERT INTO products (sku_code, barcode, name, created_at, updated_at) VALUES ('T', ?, 'x', '', '')").run(taken);
  const second = issueBarcode(db);
  assert.notEqual(second, taken);
  assert.notEqual(second, first);
  assert.ok(isValidEan13(second));
});

test('상품 등록: 바코드를 비우면 자동 발급(source=issued), 넣으면 그대로(source=external)', () => {
  const db = memDb();
  const a = createProduct(db, { name: '자동', optionName: '빨강/L' });
  const b = createProduct(db, { barcode: '8800000000015', name: '기존' });
  const pa = db.prepare('SELECT barcode, sku_code, barcode_source, name_key FROM products WHERE id = ?').get(a);
  const pb = db.prepare('SELECT barcode, barcode_source FROM products WHERE id = ?').get(b);
  assert.equal(pa.barcode_source, 'issued');
  assert.equal(pa.sku_code, pa.barcode, '상품코드를 비우면 바코드와 같게');
  assert.ok(pa.name_key.includes('|'));
  assert.equal(pb.barcode_source, 'external');
});

// 독립적으로 알려진 표준 예: 4006381333931 (왼쪽 패리티 LGLLGG)
test('EAN-13 막대 패턴이 표준과 일치한다', () => {
  const expected = '101'
    + '0001101' + '0100111' + '0101111' + '0111101' + '0001001' + '0110011' // 0 0 6 3 8 1 (L G L L G G)
    + '01010'
    + '1000010' + '1000010' + '1000010' + '1110100' + '1000010' + '1100110' // 3 3 3 9 3 1 (R)
    + '101';
  assert.equal(ean13Bits('4006381333931'), expected);
  assert.equal(ean13Bits('4006381333931').length, 95);
});

test('모든 숫자 조합에서 막대를 다시 읽으면 원래 번호가 나온다 (왕복)', () => {
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));
  const G = R.map((p) => [...p].reverse().join(''));
  const PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  const decode = (bits) => {
    assert.equal(bits.slice(0, 3), '101');
    assert.equal(bits.slice(45, 50), '01010');
    assert.equal(bits.slice(92), '101');
    let parity = '';
    let digits = '';
    for (let i = 0; i < 6; i++) {
      const seg = bits.slice(3 + 7 * i, 10 + 7 * i);
      const l = L.indexOf(seg);
      if (l >= 0) { parity += 'L'; digits += l; } else { parity += 'G'; digits += G.indexOf(seg); }
    }
    for (let i = 0; i < 6; i++) digits += R.indexOf(bits.slice(50 + 7 * i, 57 + 7 * i));
    return `${PAR.indexOf(parity)}${digits}`;
  };
  for (let n = 0; n < 300; n++) {
    const first12 = String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
    const code = first12 + ean13CheckDigit(first12);
    assert.equal(decode(ean13Bits(code)), code);
  }
});

test('SVG: 숫자 13자리만, 인라인 style 없음, 접근성 라벨', () => {
  const svg = ean13Svg('2000000000014');
  assert.match(svg, /^<svg /);
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="바코드 2000000000014"/);
  assert.ok(!/\sstyle=/.test(svg));
  assert.ok(!/<script/i.test(svg));
  assert.throws(() => ean13Svg('<script>'), /13자리/);
  assert.throws(() => ean13Svg('123'), /13자리/);
  const dbCode = addProduct(memDb(), 1) && true;
  assert.ok(dbCode);
});

test('BARCODE_PREFIX 로 접두어를 바꿀 수 있고, 잘못된 값이면 기본 77', () => {
  const old = process.env.BARCODE_PREFIX;
  try {
    process.env.BARCODE_PREFIX = '20';
    assert.match(issueBarcode(memDb()), /^20\d{11}$/);
    process.env.BARCODE_PREFIX = 'abc';
    assert.match(issueBarcode(memDb()), /^77\d{11}$/);
  } finally {
    if (old === undefined) delete process.env.BARCODE_PREFIX; else process.env.BARCODE_PREFIX = old;
  }
});

test('Code 128: 패턴표(칸 합 11, 종료 13), 숫자는 Code C 로 압축, 체크값', () => {
  assert.equal(C128_PATTERNS.table.length, 106);
  for (const [i, p] of C128_PATTERNS.table.entries()) assert.equal([...p].reduce((n, c) => n + Number(c), 0), 11, `패턴 ${i}`);
  assert.equal([...C128_PATTERNS.stop].reduce((n, c) => n + Number(c), 0), 13);
  // 13자리 숫자: START B, 첫 숫자(B), CODE C, 6쌍, 체크 — 외부 디코더(zxing)로도 이 값이 읽히는 것을 확인했다
  assert.deepEqual(code128Values('7700000000019'), [104, 23, 99, 70, 0, 0, 0, 0, 19, 69]);
  assert.deepEqual(code128Values('12345678')[0], 105); // 짝수 자리는 START C
  assert.equal(code128Bits('7700000000019').length, 10 * 11 + 13);
  assert.throws(() => code128Values('한글'), /만들 수 없는/);
  assert.throws(() => code128Values(''));
});

test('barcodeSvg: 종류 선택, EAN-13 이 아닌 번호와 한글은 안전하게 처리', () => {
  assert.match(barcodeSvg('7700000000019', 'code128'), /<svg class="barcode"/);
  assert.match(barcodeSvg('7700000000019', 'code128'), /aria-label="바코드 7700000000019"/);
  assert.notEqual(barcodeSvg('7700000000019', 'code128'), barcodeSvg('7700000000019', 'ean13'));
  assert.equal(barcodeSvg('7700000000019', 'ean13'), ean13Svg('7700000000019'));
  assert.match(barcodeSvg('GLV-001', 'ean13'), /<svg class="barcode"/); // 13자리 숫자가 아니면 종류와 상관없이 Code 128
  assert.match(barcodeSvg('상품<코드>', 'code128'), /class="label-code">상품코드</);
  assert.match(code128Svg('7700000000019'), /shape-rendering="crispEdges"/);
});
