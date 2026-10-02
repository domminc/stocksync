/** EAN-13 체크디지트 계산 (앞 12자리 → 마지막 1자리) */
export function ean13CheckDigit(first12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code) {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** 스캐너·엑셀에서 섞여 들어오는 공백, 제어문자, BOM 제거 */
export function normalizeBarcode(raw) {
  return String(raw ?? '').replace(/[\s\u0000-\u001f\u007f​﻿]/g, '');
}

/** 숫자·영문·일부 기호 4~32자. (EAN-13이 아닌 내부 코드도 허용) */
export function isAcceptableBarcode(code) {
  return /^[0-9A-Za-z\-_.]{4,32}$/.test(code);
}

/** 엑셀이 바코드를 지수 표기(8.8E+12)로 망가뜨린 값인지 */
export function looksLikeExcelDamage(code) {
  return /^\d+(\.\d+)?e[+-]?\d+$/i.test(code);
}
