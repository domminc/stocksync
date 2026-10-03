import test from 'node:test';
import assert from 'node:assert/strict';
import { monoBitmap, buildLabelJob, buildCalibrate, labelLayout, code128Modules, mmToDots, SIZES } from '../public/tspl.js';
import { code128Bits } from '../src/lib/barcodes.js';

const text = (bytes) => new TextDecoder('latin1').decode(bytes);

test('monoBitmap: 검정 픽셀은 비트 0, 흰색은 1 (TSPL 기본), blackBit=1 이면 반대', () => {
  // 8x1: 앞 3픽셀 검정, 나머지 흰색
  const px = new Uint8Array(8 * 4);
  for (let x = 0; x < 8; x++) { const v = x < 3 ? 0 : 255; px.set([v, v, v, 255], x * 4); }
  assert.deepEqual([...monoBitmap(px, 8, 1).data], [0b00011111]);
  assert.deepEqual([...monoBitmap(px, 8, 1, { blackBit: 1 }).data], [0b11100000]);
  // 너비 10 → 2바이트, 남는 비트는 흰색
  const wide = new Uint8Array(10 * 4).fill(255);
  const m = monoBitmap(wide, 10, 1);
  assert.equal(m.widthBytes, 2);
  assert.deepEqual([...m.data], [0xff, 0xff]);
  // 투명 픽셀은 흰색으로 본다
  const clear = new Uint8Array(8 * 4); // 전부 (0,0,0,0)
  assert.deepEqual([...monoBitmap(clear, 8, 1).data], [0xff]);
});

test('buildLabelJob: Code 128 라벨 — 크기·간격·비트맵·바코드·장수', () => {
  const bmp = { x: 8, y: 6, widthBytes: 2, height: 2, data: new Uint8Array([1, 2, 3, 4]) };
  const bytes = buildLabelJob({ widthMm: 50, heightMm: 30, gapMm: 2, textBitmap: bmp, copies: 3, barcode: { value: '7700000000019', kind: 'code128', y: 65, height: 110, narrow: 2 } });
  const s = text(bytes);
  assert.match(s, /^SIZE 50 mm,30 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1,0\r\nREFERENCE 0,0\r\nDENSITY 8\r\nSPEED 4\r\nCLS\r\n/);
  assert.ok(s.includes('BITMAP 8,6,2,2,0,'));
  // 비트맵 데이터(4바이트)가 그대로 들어가 있다
  const at = s.indexOf('BITMAP 8,6,2,2,0,') + 'BITMAP 8,6,2,2,0,'.length;
  assert.deepEqual([...bytes.slice(at, at + 4)], [1, 2, 3, 4]);
  // 가운데 정렬: (400 - 123칸*2점)/2 = 77
  const modules = code128Bits('7700000000019').length;
  assert.equal(code128Modules('7700000000019'), modules);
  assert.ok(s.includes(`BARCODE ${Math.round((400 - modules * 2) / 2)},65,"128",110,1,0,2,4,"7700000000019"`));
  assert.ok(s.endsWith('PRINT 1,3\r\n'));
});

test('buildLabelJob: EAN-13 은 12자리만 보내고(체크디지트는 프린터가 계산), 종류 미지정이면 Code 128', () => {
  const ean = text(buildLabelJob({ widthMm: 50, heightMm: 30, barcode: { value: '7700000000019', kind: 'ean13', y: 65, height: 100, narrow: 3 } }));
  assert.match(ean, /BARCODE 58,65,"EAN13",100,1,0,3,6,"770000000001"/);
  const dflt = text(buildLabelJob({ widthMm: 50, heightMm: 30, barcode: { value: '7700000000019', y: 65, height: 100 } }));
  assert.match(dflt, /"128"/);
  // 숫자 아닌 코드는 EAN-13 을 요청해도 Code 128
  assert.match(text(buildLabelJob({ widthMm: 50, heightMm: 30, barcode: { value: 'GLV-001', kind: 'ean13', y: 65, height: 100 } })), /"128".*"GLV-001"/);
  // 따옴표·줄바꿈은 제거되어 명령이 깨지지 않는다
  assert.ok(!text(buildLabelJob({ widthMm: 50, heightMm: 30, barcode: { value: 'A"B\r\nC', y: 1, height: 50 } })).includes('A"B'));
});

test('buildLabelJob: 농도·속도·장수는 범위로 보정, 갭/블랙마크/연속 용지, 방향', () => {
  const s = text(buildLabelJob({ widthMm: 40, heightMm: 25, density: 99, speed: 0, copies: 5000, reverse: true, media: 'bline', gapMm: 3 }));
  assert.match(s, /BLINE 3 mm,0 mm/);
  assert.match(s, /DIRECTION 0,0/);
  assert.match(s, /DENSITY 15/);
  assert.match(s, /SPEED 1/);
  assert.match(s, /PRINT 1,999/);
  assert.match(text(buildLabelJob({ widthMm: 50, heightMm: 30, media: 'continuous' })), /GAP 0 mm,0 mm/);
  assert.match(text(buildCalibrate({ widthMm: 50, heightMm: 30 })), /GAPDETECT\r\n$/);
  assert.ok(!text(buildCalibrate({ widthMm: 50, heightMm: 30 })).includes('CLS'));
});

test('labelLayout: 모든 조합에서 가격·상품명·바코드·숫자가 라벨 안에 들어온다', () => {
  for (const [key, { w, h }] of Object.entries(SIZES)) {
    for (const showName of [false, true]) {
      for (const showPrice of [false, true]) {
        const L = labelLayout(w, h, { showName, showPrice });
        const bottom = L.barcodeY + L.barcodeH + 28; // 바코드 + 사람이 읽는 숫자
        assert.ok(bottom <= L.H, `${key} name=${showName} price=${showPrice}: ${bottom} > ${L.H}`);
        assert.ok(L.barcodeH >= 30);
        assert.equal(L.textW % 8, 0);
        assert.ok(L.textX >= 0 && L.textX + L.textW <= L.W);
        if (L.textH) assert.ok(L.textY + L.textH <= L.barcodeY, `${key}: 글자와 바코드가 겹침`);
      }
    }
  }
  assert.equal(mmToDots(50), 400);
  assert.equal(mmToDots(30), 240);
});
