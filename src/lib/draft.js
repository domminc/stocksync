// 주문 이력으로 만드는 상품 초안의 보조 계산: 판매가 추정, 분류 추정.
// 읽는 값은 상품 문구·금액·날짜·상태뿐이다 (구매자 정보 등은 쓰지 않는다).

const DAY = 86400e3;

/**
 * 같은 상품의 주문 금액들로 낱개 판매가를 추정한다.
 *  - 최근 180일 주문이 3건 이상이면 그 기간만 쓰고, 아니면 전체를 쓴다 (가격 인상·세일 반영).
 *  - 가장 많이 나온 금액을 고르되, 그 금액이 더 작은 금액의 정수배(2~6배)이고 작은 쪽도 충분히 나오면 "여러 개 주문"으로 보고 작은 금액을 낱개 가격으로 본다.
 *  - 결제금액(paid)과 10% 넘게 다르면 할인·쿠폰 가능성을 메모로 남긴다.
 * samples: [{ amount, paid, at }]  (at: ISO 날짜 문자열)
 */
export function estimateUnitPrice(samples, { now = Date.now(), recentDays = 180 } = {}) {
  // 스마트스토어 [오늘출발] 상품 등은 주문금액이 결제금액의 정확히 2배로 이중 집계되어 온다 → 이런 줄은 결제금액을 쓴다
  let doubled = 0;
  const usable = samples.map((s) => {
    const amount = Number(s.amount);
    const paid = Number(s.paid);
    if (paid > 0 && amount > 0 && Math.abs(amount / paid - 2) < 0.01) { doubled++; return { ...s, amount: paid }; }
    return { ...s, amount };
  }).filter((s) => s.amount > 0);
  if (!usable.length) return { price: null, confidence: 'none', note: '금액 정보 없음' };
  const cut = now - recentDays * DAY;
  const recent = usable.filter((s) => Date.parse(s.at) >= cut);
  const pool = recent.length >= 3 ? recent : usable;
  const count = new Map();
  const latest = new Map();
  for (const s of pool) {
    count.set(s.amount, (count.get(s.amount) ?? 0) + 1);
    latest.set(s.amount, Math.max(latest.get(s.amount) ?? 0, Date.parse(s.at) || 0));
  }
  const ranked = [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || latest.get(b) - latest.get(a));
  let price = ranked[0];
  let bundle = false;
  for (const small of [...count.keys()].filter((v) => v < price).sort((a, b) => a - b)) {
    const k = price / small;
    if (Number.isInteger(k) && k >= 2 && k <= 6 && count.get(small) >= Math.max(2, 0.25 * count.get(price))) { price = small; bundle = true; break; }
  }
  const share = count.get(price) / pool.length;
  const confidence = share >= 0.6 && pool.length >= 5 ? 'high' : (share >= 0.4 || pool.length >= 3 ? 'mid' : 'low');
  const notes = [];
  if (pool === usable && recent.length < 3) notes.push('최근 주문 적음');
  if (count.size > 1) notes.push(`금액 ${count.size}종`);
  if (bundle) notes.push('여러 개 주문 제외');
  if (doubled) notes.push(`주문금액 2배 보정 ${doubled}건`);
  const paids = pool.map((s) => Number(s.paid)).filter((v) => v > 0);
  if (paids.length >= 3 && !doubled) {
    const pc = new Map();
    for (const v of paids) pc.set(v, (pc.get(v) ?? 0) + 1);
    const paidMode = [...pc.keys()].sort((a, b) => pc.get(b) - pc.get(a))[0];
    if (Math.abs(paidMode - price) / price > 0.1) notes.push(`결제금액 ${paidMode.toLocaleString('ko-KR')} (할인·쿠폰?)`);
  }
  return { price, confidence, note: notes.join(' · '), orders: pool.length };
}

const CATEGORIES = [
  ['관리용품', /오일|클리너|케어|관리용|스프레이|왁스|세척|길들이기/],
  ['보호장비', /헬멧|마스크|보호대|보호시트|프로텍터|포수장비|엄지보호|손가락보호|가드|쉬드|보호구/],
  ['야구화', /야구화|스파이크|슈즈|신발/],
  ['글러브', /글러브|미트|내야수|외야수|올라운드/],
  ['배트', /배트|방망이/],
  ['야구공', /야구공|연식구|경식구|연습구/],
  ['의류·잡화', /유니폼|져지|저지|상의|하의|바지|모자|양말|스타킹|언더|아대|장갑|벨트|가방/],
  ['훈련용품', /튜빙|밴드|배팅티|훈련|네트|토스|연습/],
];
/** 상품명으로 분류를 대충 짐작한다 (틀릴 수 있으니 가져온 뒤 확인) */
export function guessCategory(name) {
  const n = String(name);
  for (const [cat, re] of CATEGORIES) if (re.test(n)) return cat;
  return '기타';
}
