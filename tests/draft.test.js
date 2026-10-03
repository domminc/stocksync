import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateUnitPrice, guessCategory } from '../src/lib/draft.js';

const NOW = Date.parse('2026-10-01T00:00:00+09:00');
const s = (amount, at = '2026-09-20T10:00:00+09:00', paid = 0) => ({ amount, paid, at });

test('estimateUnitPrice: 가장 많이 나온 금액, 여러 개 주문(정수배)은 낱개로 환산', () => {
  const many = [...Array(10).fill(15800), 31600, 31600, 47400].map((a) => s(a));
  const r = estimateUnitPrice(many, { now: NOW });
  assert.equal(r.price, 15800);
  assert.equal(r.confidence, 'high');
  // 낱개 금액이 거의 안 나오면 정수배라도 낱개로 환산하지 않는다
  assert.equal(estimateUnitPrice([s(20000), s(20000), s(20000), s(10000)], { now: NOW }).price, 20000);
  // 낱개가 충분히 나오면 환산한다
  assert.equal(estimateUnitPrice([s(20000), s(20000), s(20000), s(10000), s(10000)], { now: NOW }).price, 10000);
});

test('estimateUnitPrice: 최근 180일 주문이 3건 이상이면 최근 가격, 아니면 전체', () => {
  const old = Array(20).fill(0).map(() => s(30000, '2025-01-10T00:00:00+09:00'));
  const recent = [s(25000), s(25000), s(25000)];
  assert.equal(estimateUnitPrice([...old, ...recent], { now: NOW }).price, 25000);
  const r = estimateUnitPrice([...old, s(25000)], { now: NOW });
  assert.equal(r.price, 30000);
  assert.match(r.note, /최근 주문 적음/);
});

test('estimateUnitPrice: 주문금액이 결제금액의 정확히 2배(이중 집계)면 결제금액으로 보정', () => {
  const rows = Array(6).fill(0).map(() => s(15800, '2026-09-20T10:00:00+09:00', 7900));
  const r = estimateUnitPrice(rows, { now: NOW });
  assert.equal(r.price, 7900);
  assert.match(r.note, /2배 보정 6건/);
});

test('estimateUnitPrice: 결제금액과 10% 넘게 다르면 메모, 금액이 없으면 null', () => {
  const rows = Array(5).fill(0).map(() => s(19000, '2026-09-20T10:00:00+09:00', 14500));
  const r = estimateUnitPrice(rows, { now: NOW });
  assert.equal(r.price, 19000);
  assert.match(r.note, /결제금액 14,500/);
  assert.deepEqual(estimateUnitPrice([s(0), s(0)], { now: NOW }), { price: null, confidence: 'none', note: '금액 정보 없음' });
  assert.equal(estimateUnitPrice([], { now: NOW }).price, null);
});

test('guessCategory: 관리용품·보호장비가 글러브보다 먼저, 모르면 기타', () => {
  assert.equal(guessCategory('DX 대쉬 글러브오일 야구글러브 관리용'), '관리용품');
  assert.equal(guessCategory('벨가드 포수엄지보호 시트 손가락보호대'), '보호장비');
  assert.equal(guessCategory('WE 위 내야글러브 내야수 재팬'), '글러브');
  assert.equal(guessCategory('컨템포 야구배트 수축튜브'), '배트');
  assert.equal(guessCategory('미즈노 야구양말 농군양말'), '의류·잡화');
  assert.equal(guessCategory('BMC 야구튜빙밴드 어깨재활'), '훈련용품');
  assert.equal(guessCategory('알 수 없는 물건'), '기타');
});
