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

// ---- Code 128 (숫자·영문 모두 읽는 범용 바코드. 스캐너 호환성이 가장 넓다) ----
// 각 값(0~105)의 막대/공백 너비 패턴 6개, 마지막은 종료 패턴 7개
const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232'];
const C128_STOP = '2331112';
export const C128_PATTERNS = { table: C128, stop: C128_STOP };

/** 문자열 → Code 128 기호값 배열 (시작·체크·종료 제외 전). 숫자만이면 Code C 로 절반 길이로 줄인다. */
export function code128Values(text) {
  const s = String(text);
  if (!s.length) throw new Error('바코드 내용이 비어 있습니다.');
  const values = [];
  if (/^\d+$/.test(s) && s.length >= 4) {
    let i = 0;
    if (s.length % 2 === 1) { values.push(104, s.charCodeAt(0) - 32, 99); i = 1; } // B 시작 → 첫 숫자 → C 로 전환
    else values.push(105);
    for (; i < s.length; i += 2) values.push(Number(s.slice(i, i + 2)));
  } else {
    values.push(104);
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (c < 32 || c > 126) throw new Error('Code 128 로 만들 수 없는 문자가 있습니다.');
      values.push(c - 32);
    }
  }
  let sum = values[0];
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  return values;
}

/** Code 128 → 막대 패턴('1'=검정). 앞뒤 여백은 포함하지 않는다. */
export function code128Bits(text) {
  let bits = '';
  let black = true;
  const run = (widths) => { for (const w of widths) { bits += (black ? '1' : '0').repeat(Number(w)); black = !black; } };
  for (const v of code128Values(text)) { black = true; run(C128[v]); }
  black = true; run(C128_STOP);
  return bits;
}

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

// ---- EAN-13 막대 그리기 (라벨 인쇄용 SVG) ----
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));
const G = R.map((p) => [...p].reverse().join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** 13자리 EAN-13 → 95칸 막대 패턴('1'=검정, '0'=흰색) */
export function ean13Bits(code) {
  if (!/^\d{13}$/.test(code)) throw new Error('EAN-13 은 숫자 13자리여야 합니다.');
  const parity = PARITY[Number(code[0])];
  let bits = '101';
  for (let i = 0; i < 6; i++) bits += (parity[i] === 'L' ? L : G)[Number(code[i + 1])];
  bits += '01010';
  for (let i = 0; i < 6; i++) bits += R[Number(code[i + 7])];
  return `${bits}101`;
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
