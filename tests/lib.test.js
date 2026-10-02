import test from 'node:test';
import assert from 'node:assert/strict';
import { ean13CheckDigit, isValidEan13, normalizeBarcode, looksLikeExcelDamage } from '../src/lib/ean13.js';
import { parseCsv, decodeText, csvCell, resolveColumns } from '../src/lib/csv.js';
import { can } from '../src/lib/permissions.js';
import { hashPassword, verifyPassword, validatePassword } from '../src/lib/auth.js';
import { mapSourceStatus } from '../src/lib/orders.js';

test('EAN-13 체크디지트', () => {
  assert.equal(ean13CheckDigit('400638133393'), 1);
  assert.ok(isValidEan13('4006381333931'));
  assert.ok(!isValidEan13('4006381333932'));
  assert.ok(!isValidEan13('400638133393'));
});

test('바코드 정리와 엑셀 변형 감지', () => {
  assert.equal(normalizeBarcode(' 8800000000015\r\n'), '8800000000015');
  assert.equal(normalizeBarcode('﻿88 00'), '8800');
  assert.ok(looksLikeExcelDamage('8.80001E+12'));
  assert.ok(!looksLikeExcelDamage('8800000000015'));
});

test('CSV: 따옴표·줄바꿈·구분자', () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y",3\r\n"he said ""hi""","line1\nline2",z\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', '3'], ['he said "hi"', 'line1\nline2', 'z']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('CSV: UTF-8 BOM 제거, EUC-KR 대체 해석', () => {
  assert.equal(decodeText(Buffer.from('﻿바코드,상품명')), '바코드,상품명');
  const euckr = new Uint8Array([0xb9, 0xd9, 0xc4, 0xda, 0xb5, 0xe5]); // 바코드
  assert.equal(decodeText(euckr), '바코드');
});

test('CSV 열 이름 인식은 공백·대소문자·우선순위를 무시한다', () => {
  const idx = resolveColumns([' 주문 번호 ', 'SKU', '바코드'], { orderNo: ['주문번호'], code: ['바코드', 'sku'] });
  assert.equal(idx.orderNo, 0);
  assert.equal(idx.code, 2); // 바코드가 sku보다 우선
});

test('CSV 내보내기: 수식 삽입 방지', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('정상'), '정상');
});

test('역할별 권한', () => {
  assert.ok(can('admin', 'user.manage'));
  assert.ok(!can('manager', 'user.manage'));
  assert.ok(can('staff', 'stock.in') && can('staff', 'stock.out'));
  assert.ok(!can('staff', 'stock.adjust') && !can('staff', 'product.import'));
  assert.ok(can('online', 'order.ship') && !can('online', 'stock.in'));
  assert.ok(can('viewer', 'view') && !can('viewer', 'order.ship'));
  assert.ok(!can('admin', 'does.not.exist'));
});

test('비밀번호 해시 검증', () => {
  const h = hashPassword('correct-horse-battery');
  assert.ok(verifyPassword('correct-horse-battery', h));
  assert.ok(!verifyPassword('wrong-password-1', h));
  assert.ok(!verifyPassword('x', 'garbage'));
  assert.ok(validatePassword('short'));
  assert.equal(validatePassword('long-enough-pass'), null);
});

test('주문 상태 문구 해석', () => {
  assert.equal(mapSourceStatus('신규주문'), 'pending');
  assert.equal(mapSourceStatus('배송준비중'), 'pending');
  assert.equal(mapSourceStatus('출고대기'), 'pending');
  assert.equal(mapSourceStatus('배송중'), 'closed');
  assert.equal(mapSourceStatus('구매확정'), 'closed');
  assert.equal(mapSourceStatus('취소완료'), 'canceled');
  assert.equal(mapSourceStatus('반품요청'), 'claim');
  assert.equal(mapSourceStatus(''), 'pending');
});
