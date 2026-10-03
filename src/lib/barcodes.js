import { tx } from '../db.js';
import { ean13CheckDigit } from './ean13.js';

/**
 * 자체 발급 바코드 형식: 접두어 2자리 + 일련번호 10자리 + 체크디지트.
 * 접두어는 기본 '77' 이고 BARCODE_PREFIX(숫자 2자리)로 바꿀 수 있다. 이미 발급한 바코드는 바뀌지 않는다.
 * 참고: 20~29 는 GS1 이 “매장 내부용”으로 비워 둔 범위다. 77x 는 다른 나라에 배정된 국가 접두어 범위라
 * 회사 안에서 쓰는 데는 문제가 없지만, 쇼핑몰 상품 등록용 정식 바코드로는 쓸 수 없다.
 */
export const DEFAULT_PREFIX = '77';
export function barcodePrefix() {
  const v = String(process.env.BARCODE_PREFIX ?? '').trim();
  return /^\d{2}$/.test(v) ? v : DEFAULT_PREFIX;
}
export const INTERNAL_PREFIX = DEFAULT_PREFIX;

export function issueBarcode(db) {
  return tx(db, () => {
    for (let guard = 0; guard < 10000; guard++) {
      const { next_serial: serial } = db.prepare('SELECT next_serial FROM barcode_counter WHERE id = 1').get();
      if (serial > 9999999999) throw new Error('자체 바코드 일련번호를 모두 사용했습니다.');
      db.prepare('UPDATE barcode_counter SET next_serial = ? WHERE id = 1').run(serial + 1);
      const first12 = barcodePrefix() + String(serial).padStart(10, '0');
      const code = first12 + ean13CheckDigit(first12);
      if (!db.prepare('SELECT 1 FROM products WHERE barcode = ?').get(code)) return code;
    }
    throw new Error('자체 바코드를 발급하지 못했습니다.');
  });
}

import { C128_PATTERNS, code128Values, code128Bits, ean13Bits } from '../../public/barcode-bits.js';
export { C128_PATTERNS, code128Values, code128Bits, ean13Bits };

/** 인쇄용 SVG. 막대는 정수 칸 단위로만 그려 프린터가 선명하게 찍도록 한다. */
export function code128Svg(code, { barHeight = 46, text = true } = {}) {
  const bits = code128Bits(code);
  const QUIET128 = 10;
  const textH = text ? 11 : 0;
  const width = bits.length + QUIET128 * 2;
  const height = barHeight + 4 + textH;
  let rects = '';
  for (let i = 0; i < bits.length;) {
    if (bits[i] === '0') { i++; continue; }
    let j = i;
    while (j < bits.length && bits[j] === '1') j++;
    rects += `<rect x="${QUIET128 + i}" y="0" width="${j - i}" height="${barHeight}"/>`;
    i = j;
  }
  const label = String(code).replace(/[<>&"]/g, '');
  const digits = text ? `<text x="${width / 2}" y="${barHeight + 4 + 9}" text-anchor="middle" letter-spacing="1">${label}</text>` : '';
  return `<svg class="barcode" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="바코드 ${label}" shape-rendering="crispEdges"><g fill="#000">${rects}</g><g fill="#000" font-family="Arial, sans-serif" font-size="9">${digits}</g></svg>`;
}

/** 종류에 맞는 SVG ('code128' 또는 'ean13'). EAN-13 이 아닌 번호는 종류와 상관없이 Code 128. */
export function barcodeSvg(code, kind = 'code128', opts) {
  if (kind === 'ean13' && /^\d{13}$/.test(code)) return ean13Svg(code, opts);
  try {
    return code128Svg(code, opts);
  } catch {
    // Code 128 로 만들 수 없는 문자(한글 등)는 숫자 문구만 인쇄한다
    return `<div class="label-code">${String(code).replace(/[<>&"]/g, '')}</div>`;
  }
}

const QUIET = 9;

/** 인쇄용 SVG 문자열. 숫자만 들어가므로 그대로 HTML 에 넣어도 안전하다. */
export function ean13Svg(code, { barHeight = 46, text = true } = {}) {
  const bits = ean13Bits(code);
  const guardIdx = (i) => i < 3 || (i >= 45 && i < 50) || i >= 92;
  const textH = text ? 11 : 0;
  const width = bits.length + QUIET * 2;
  const height = barHeight + 5 + textH;
  let rects = '';
  let i = 0;
  while (i < bits.length) {
    if (bits[i] === '0') { i++; continue; }
    let j = i;
    while (j < bits.length && bits[j] === '1' && guardIdx(j) === guardIdx(i)) j++;
    rects += `<rect x="${QUIET + i}" y="0" width="${j - i}" height="${guardIdx(i) ? barHeight + 5 : barHeight}"/>`;
    i = j;
  }
  let digits = '';
  if (text) {
    const ty = barHeight + 5 + 9;
    digits += `<text x="${QUIET - 4}" y="${ty}" text-anchor="middle">${code[0]}</text>`;
    for (let k = 0; k < 6; k++) digits += `<text x="${QUIET + 3 + 7 * k + 3.5}" y="${ty}" text-anchor="middle">${code[k + 1]}</text>`;
    for (let k = 0; k < 6; k++) digits += `<text x="${QUIET + 50 + 7 * k + 3.5}" y="${ty}" text-anchor="middle">${code[k + 7]}</text>`;
  }
  return `<svg class="barcode" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="바코드 ${code}" shape-rendering="crispEdges"><g fill="#000">${rects}</g><g fill="#000" font-family="Arial, sans-serif" font-size="9">${digits}</g></svg>`;
}
