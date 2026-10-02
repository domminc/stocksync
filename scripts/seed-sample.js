// 화면을 확인해 보기 위한 샘플 데이터 (실제 운영 DB에는 쓰지 마세요)
//   DB_PATH=data/demo.db npm run seed -- [상품수=300]
import { openDb } from '../src/db.js';
import { createUser } from '../src/lib/auth.js';
import { importProducts } from '../src/lib/products.js';
import { importOrders } from '../src/lib/orders.js';
import { ean13CheckDigit } from '../src/lib/ean13.js';

const count = Number(process.argv[2] || 300);
const dbPath = process.env.DB_PATH || 'data/demo.db';
const db = openDb(dbPath);

if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0) {
  console.error(`${dbPath} 에 이미 상품이 있습니다. 새 DB_PATH 를 지정하세요.`);
  process.exit(1);
}

const ean = (n) => { const f = String(880000000000 + n); return f + ean13CheckDigit(f); };
const kinds = ['야구글러브', '배트', '야구화', '유니폼 상의', '야구모자', '포수 장비', '배팅장갑', '야구공 (12구)'];
const colors = ['블랙', '네이비', '화이트', '레드'];
const sizes = ['S', 'M', 'L', 'XL'];

const lines = ['바코드,상품코드,상품명,옵션,분류,판매가,안전재고,재고관리,현재고'];
for (let i = 1; i <= count; i++) {
  const kind = kinds[i % kinds.length];
  const stock = i % 11 === 0 ? 0 : (i * 7) % 40;
  lines.push([ean(i), `DEMO-${String(i).padStart(5, '0')}`, `샘플 ${kind} ${Math.ceil(i / 4)}`, `${colors[i % 4]}/${sizes[i % 4]}`, kind, 10000 + (i % 30) * 3000, i % 5 === 0 ? 10 : 0, 'Y', stock].join(','));
}
const rep = importProducts(db, lines.join('\n'));

const orders = ['주문번호,주문상품번호,쇼핑몰,바코드,상품명,수량,주문상태,주문일시'];
for (let i = 1; i <= 25; i++) {
  orders.push([`DEMO-ORD-${1000 + i}`, 1, i % 2 ? '스마트스토어' : '쿠팡', ean((i * 3) % count + 1), `샘플 주문 상품 ${i}`, 1 + (i % 3), '신규주문', '2026-10-02 09:00'].join(','));
}
orders.push('DEMO-ORD-2001,1,쿠팡,PA-UNKNOWN-1,플레이오토 코드만 있는 상품,1,신규주문,2026-10-02 09:30');
// 코드 없이 상품명만 있는 주문: 첫 줄은 자동 매칭, 둘째 줄은 표기가 달라 매칭 대기(후보 제안), 셋째는 추가상품(자동 제외)
orders.push('DEMO-ORD-3001,1,스마트스토어,,[오늘출발]샘플 배트 1 / 색상: 네이비 / 사이즈: M,1,신규주문,2026-10-02 10:00');
orders.push('DEMO-ORD-3002,1,쿠팡,,샘플 야구화 2 시즌 특가 / 화이트/L,2,신규주문,2026-10-02 10:05');
orders.push('DEMO-ORD-3003,1,스마트스토어,,┗(추가상품)레이저 각인 신청 / 각인 내용: 홍,1,신규주문,2026-10-02 10:10');
const orep = importOrders(db, orders.join('\n'), { filename: 'demo' });

const users = [['admin', '본사 관리자', 'admin'], ['manager', '매장 관리자', 'manager'], ['staff', '매장 직원', 'staff'], ['online', '온라인 운영자', 'online'], ['viewer', '조회 전용', 'viewer']];
for (const [u, name, role] of users) createUser(db, { username: u, displayName: name, password: 'demo-password-1234', role });

console.log(`상품 ${rep.created}개, 주문 ${orep.inserted}건, 사용자 ${users.length}명을 만들었습니다.`);
console.log('로그인: admin / manager / staff / online / viewer  —  비밀번호 demo-password-1234 (데모 전용)');
