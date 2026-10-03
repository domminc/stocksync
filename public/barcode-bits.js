// 바코드 막대 패턴 계산 (순수 함수). 서버(SVG 미리보기)와 브라우저(PDF·프린터 명령)가 같이 쓴다.
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

