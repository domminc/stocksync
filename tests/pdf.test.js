import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLabelsPdf, barRuns } from '../public/pdf-labels.js';
import { code128Bits, ean13Bits } from '../public/barcode-bits.js';
import { code128Bits as serverBits } from '../src/lib/barcodes.js';

const latin1 = (b) => new TextDecoder('latin1').decode(b);

test('barRuns: 연속 막대 구간', () => {
  assert.deepEqual(barRuns('0110111000'), [{ start: 1, len: 2 }, { start: 4, len: 3 }]);
  assert.deepEqual(barRuns('000'), []);
  assert.deepEqual(barRuns('111'), [{ start: 0, len: 3 }]);
});

test('바코드 계산 모듈은 서버와 브라우저가 같은 코드를 쓴다', () => {
  assert.equal(serverBits('7700000000019'), code128Bits('7700000000019'));
  assert.equal(ean13Bits('7700000000019').length, 95);
});

test('buildLabelsPdf: 페이지 크기=라벨 크기, 장수만큼 페이지, 객체 위치표(xref)가 정확하다', () => {
  const bits = code128Bits('7700000000019');
  const bytes = buildLabelsPdf({
    widthMm: 50, heightMm: 30,
    labels: [
      { copies: 2, image: { widthPx: 16, heightPx: 2, data: new Uint8Array([0, 255, 255, 0]), xMm: 1, yMm: 1, wMm: 2, hMm: 0.25 }, barcode: { bits, moduleMm: 0.25, xMm: 9, yMm: 8, hMm: 12 }, human: { text: '7700000000019', yMm: 20.5, sizePt: 7 } },
      { copies: 1, image: null, barcode: null, human: null },
    ],
  });
  const text = latin1(bytes);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/MediaBox \[0 0 141\.732 85\.039\]/);
  assert.match(text, /\/Count 3/);
  assert.equal((text.match(/\/Type \/Page /g) || []).length, 3);
  // 1비트 이미지 마스크
  assert.match(text, /\/ImageMask true \/BitsPerComponent 1/);
  // 막대 사각형 개수 = 막대 구간 수
  assert.equal((text.match(/ re\n/g) || []).length, barRuns(bits).length);
  assert.match(text, /\(7700000000019\) Tj/);
  // xref: 각 객체 위치가 "N 0 obj" 를 가리킨다
  const start = Number(/startxref\n(\d+)\n/.exec(text)[1]);
  assert.ok(text.slice(start).startsWith('xref'));
  const lines = text.slice(start).split('\n');
  const n = Number(lines[1].split(' ')[1]);
  for (let i = 1; i < n; i++) {
    const off = Number(lines[2 + i].slice(0, 10));
    assert.ok(text.slice(off).startsWith(`${i} 0 obj`), `객체 ${i} 위치`);
  }
});

test('buildLabelsPdf: 라벨이 없으면 오류, 한 라벨 장수는 1~999 로 보정', () => {
  assert.throws(() => buildLabelsPdf({ widthMm: 50, heightMm: 30, labels: [] }), /출력할 라벨이 없습니다/);
  const t = latin1(buildLabelsPdf({ widthMm: 40, heightMm: 25, labels: [{ copies: 5000, image: null, barcode: null, human: { text: 'A-1', yMm: 5, sizePt: 7 } }] }));
  assert.match(t, /\/Count 999/);
  assert.match(t, /\/MediaBox \[0 0 113\.386 70\.866\]/);
});
