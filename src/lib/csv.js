/** 바이트를 문자열로. UTF-8이 아니면 한국어 엑셀 CSV(CP949/EUC-KR)로 해석한다. */
export function decodeText(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}

/** 따옴표, 줄바꿈, 쉼표/탭/세미콜론 구분자를 처리하는 CSV 파서. 행 배열(문자열 배열)을 돌려준다. */
export function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let delim = ',';
  let best = -1;
  for (const c of [',', '\t', ';']) {
    const n = firstLine.split(c).length - 1;
    if (n > best) { best = n; delim = c; }
  }
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export const normHeader = (s) => String(s ?? '').replace(/[\s_\-()[\]]/g, '').toLowerCase();

/** spec = { 필드: [헤더 후보...] } → { 필드: 열 번호 }. 후보는 앞에 있을수록 우선한다. */
export function resolveColumns(headers, spec) {
  const normalized = headers.map(normHeader);
  const idx = {};
  for (const [field, aliases] of Object.entries(spec)) {
    for (const alias of aliases) {
      const i = normalized.indexOf(normHeader(alias));
      if (i >= 0) { idx[field] = i; break; }
    }
  }
  return idx;
}

/** CSV 수식 삽입 방지: 엑셀에서 열 때 =, +, -, @ 로 시작하는 값이 수식으로 실행되지 않게 한다. */
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
