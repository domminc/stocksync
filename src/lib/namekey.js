/**
 * 코드가 없는 주문 파일("상품명 / 옵션: 값 / 옵션: 값")을 상품 목록과 맞추기 위한 정규화.
 * 상품 쪽(name, option)과 주문 쪽(item_name)에 같은 규칙을 적용해 같은 키가 나오면 같은 상품으로 본다.
 */
const NO_OPTION = new Set(['기본', '단일', '단일상품', '없음', '옵션없음', '선택없음', 'default', 'none']);

const squash = (s) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** 앞쪽 [오늘출발] 같은 말머리를 떼고 공백·기호를 없앤 상품명 */
export function normalizeName(name) {
  const s = String(name ?? '').normalize('NFKC').replace(/^(\s*\[[^\]]*\])+/, '');
  return squash(s);
}

/** "사이즈: L / 색상: 블랙" → "l+블랙" (항목 이름표를 떼고 순서와 무관하게 정렬) */
export function normalizeOption(option) {
  const parts = String(option ?? '').normalize('NFKC').split('/').map((seg) => {
    let t = seg.trim();
    const m = /^[^:=]{1,20}[:=](.*)$/.exec(t);
    if (m) t = m[1];
    return squash(t);
  }).filter((x) => x && !NO_OPTION.has(x));
  parts.sort();
  return parts.join('+');
}

export function makeNameKey(name, option = '') {
  const n = normalizeName(name);
  return n ? `${n}|${normalizeOption(option)}` : '';
}

/** 주문 파일의 상품 문구를 상품명/옵션으로 나눈다 (첫 " / " 기준). */
export function splitOrderItemName(itemName) {
  const s = String(itemName ?? '');
  const i = s.indexOf(' / ');
  return i < 0 ? { name: s, option: '' } : { name: s.slice(0, i), option: s.slice(i + 3) };
}

/** 자수 신청·각인 같은 “추가상품” 줄인지 */
export const isAddonLine = (itemName) => /^\s*┗/.test(String(itemName ?? '')) || /\(추가상품\)/.test(String(itemName ?? ''));

/** 후보 검색에 쓸 단어들 (2자 이상, 중복 제거) */
export function searchTokens(text, max = 8) {
  const seen = new Set();
  for (const t of String(text ?? '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}\-]+/u)) {
    const tok = t.replace(/^-+|-+$/g, '');
    if (tok.length >= 2) seen.add(tok);
  }
  // 모델 번호처럼 숫자가 섞인 단어를 먼저 쓴다 (가장 구별력이 높다)
  return [...seen].sort((a, b) => Number(/\d/.test(b)) - Number(/\d/.test(a)) || b.length - a.length).slice(0, max);
}
