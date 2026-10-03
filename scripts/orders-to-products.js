// 상품 목록이 아직 없을 때 쓰는 "초안 만들기":
// 주문 내역(JSON 또는 CSV)에 나온 상품명 문구를 상품/옵션으로 나누고 중복을 합쳐 상품 가져오기용 CSV 를 만든다.
//
//   node scripts/orders-to-products.js <주문파일(.json|.csv)> [출력.csv]
//
// - 읽는 것은 상품 문구와(JSON 일 때) 주문금액·결제금액·주문일·상태뿐이다. 구매자 정보 등 다른 열은 읽지 않는다.
// - JSON 이면 주문 금액으로 판매가를 추정해 채우고(가격신뢰도·가격메모 참고 열), 분류도 상품명으로 짐작한다. 반드시 눈으로 확인하세요.
// - 판매 이력이 있는 상품만 나온다 (등록만 하고 팔리지 않은 상품은 없음). 쇼핑몰마다 상품명 표기가 다르면 같은 물건이 둘로 나올 수 있으니
//   가져오기 전에 결과를 눈으로 확인하고, 가능하면 플레이오토/쇼핑몰의 상품 목록 파일을 쓰는 편이 정확하다.
import fs from 'node:fs';
import { parseCsv, decodeText, resolveColumns, csvCell } from '../src/lib/csv.js';
import { splitOrderItemName, isAddonLine, makeNameKey } from '../src/lib/namekey.js';
import { estimateUnitPrice, guessCategory } from '../src/lib/draft.js';

const [inPath, outPath = 'products-draft.csv'] = process.argv.slice(2);
if (!inPath) {
  console.error('사용법: node scripts/orders-to-products.js <주문파일(.json|.csv)> [출력.csv]');
  process.exit(1);
}

const raw = fs.readFileSync(inPath);
let recs = []; // { full, amount, paid, at }
if (inPath.toLowerCase().endsWith('.json')) {
  const data = JSON.parse(raw.toString('utf-8'));
  const list = Array.isArray(data) ? data : (data.items ?? []);
  recs = list.filter((r) => typeof r.item_name === 'string')
    .map((r) => ({ full: r.item_name, amount: Number(r.order_amount) || 0, paid: Number(r.paid_amount) || 0, at: String(r.ordered_at ?? '') }));
} else {
  const rows = parseCsv(decodeText(raw));
  const cols = resolveColumns(rows[0] ?? [], { name: ['상품명', '주문상품명', '주문상품', 'itemname'] });
  if (cols.name === undefined) { console.error('상품명 열을 찾지 못했습니다.'); process.exit(1); }
  recs = rows.slice(1).map((r) => ({ full: r[cols.name] ?? '', amount: 0, paid: 0, at: '' })).filter((r) => r.full);
}
const names = recs.map((r) => r.full);

const seen = new Map();
let addons = 0;
for (const rec of recs) {
  if (isAddonLine(rec.full)) { addons++; continue; }
  const { name, option } = splitOrderItemName(rec.full.trim());
  const key = makeNameKey(name, option);
  if (!key) continue;
  const cur = seen.get(key);
  const sample = { amount: rec.amount, paid: rec.paid, at: rec.at };
  if (cur) { cur.orders++; cur.samples.push(sample); } else seen.set(key, { name: name.trim(), option: option.trim(), orders: 1, samples: [sample] });
}

const CONF = { high: '높음', mid: '보통', low: '낮음', none: '없음' };
const rows = [...seen.values()].sort((a, b) => b.orders - a.orders);
const lines = ['바코드,상품코드,상품명,옵션,분류,판매가,안전재고,재고관리,현재고,주문건수(참고),가격신뢰도(참고),가격메모(참고)'];
const stat = { high: 0, mid: 0, low: 0, none: 0 };
for (const r of rows) {
  const est = estimateUnitPrice(r.samples);
  stat[est.confidence]++;
  lines.push(['', '', r.name, r.option, guessCategory(r.name), est.price ?? '', '', 'Y', '', r.orders, CONF[est.confidence], est.note].map(csvCell).join(','));
}
fs.writeFileSync(outPath, `\ufeff${lines.join('\r\n')}\r\n`);

const names1 = new Set(rows.map((r) => makeNameKey(r.name, '')));
console.log(`주문 줄 ${names.length.toLocaleString()}개 → 추가상품 ${addons.toLocaleString()}개 제외 → 상품/옵션 ${rows.length.toLocaleString()}개 (상품명 기준 ${names1.size.toLocaleString()}종)`);
console.log(`판매가 추정 신뢰도: 높음 ${stat.high.toLocaleString()} · 보통 ${stat.mid.toLocaleString()} · 낮음 ${stat.low.toLocaleString()} · 없음 ${stat.none.toLocaleString()}`);
console.log(`저장: ${outPath}  — “상품 가져오기”에 그대로 올리면 바코드가 자동 발급됩니다. ('…(참고)' 열은 무시됨)`);
