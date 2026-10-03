import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSession, minPasswordLength } from './lib/auth.js';
import { can, ROLES } from './lib/permissions.js';
import { fmtTime } from './lib/time.js';
import { StockError, EVENT_LABEL, STATUS_LABEL, stockStatus } from './lib/inventory.js';
import { ValidationError } from './lib/products.js';
import { registerAuth } from './routes/auth.js';
import { registerDashboard } from './routes/dashboard.js';
import { registerProducts } from './routes/products.js';
import { registerStock } from './routes/stock.js';
import { registerOrders } from './routes/orders.js';
import { registerUsers } from './routes/users.js';
import { registerLabels } from './routes/labels.js';
import { ean13Svg, barcodeSvg } from './lib/barcodes.js';
import { pageSizeFor } from './lib/pagesize.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 화면 파일(CSS/JS)이 바뀌면 주소의 ?v= 값도 바뀌어, 브라우저가 예전 파일을 캐시로 쓰지 않게 한다.
function assetVersion() {
  const h = crypto.createHash('sha1');
  for (const f of ['style.css', 'app.js', 'tspl.js', 'label-print.js']) {
    try { h.update(fs.readFileSync(path.join(root, 'public', f))); } catch { /* 없으면 건너뜀 */ }
  }
  return h.digest('hex').slice(0, 10);
}

const NAV = [
  { group: '현황', items: [
    { href: '/', label: '대시보드', icon: 'home', perm: 'view', exact: true },
    { href: '/products', label: '상품·재고', icon: 'box', perm: 'view', exact: false, not: ['/products/import'] },
    { href: '/ledger', label: '재고 원장', icon: 'list', perm: 'view' },
    { href: '/labels', label: '라벨 인쇄', icon: 'tag', perm: 'label.print' },
  ] },
  { group: '매장', items: [
    { href: '/scan/in', label: '입고 스캔', icon: 'in', perm: 'stock.in' },
    { href: '/scan/out', label: '출고 스캔', icon: 'out', perm: 'stock.out' },
    { href: '/adjust', label: '재고 조정', icon: 'sliders', perm: 'stock.adjust' },
  ] },
  { group: '온라인', items: [
    { href: '/orders', label: '주문 목록', icon: 'cart', perm: 'view', exact: true },
    { href: '/orders/ship', label: '출고 스캔', icon: 'truck', perm: 'order.ship' },
    { href: '/orders/import', label: '주문 가져오기', icon: 'upload', perm: 'order.import' },
    { href: '/orders/unmatched', label: '매칭 대기', icon: 'link', perm: 'order.match' },
  ] },
  { group: '관리', items: [
    { href: '/products/import', label: '상품 가져오기', icon: 'upload', perm: 'product.import' },
    { href: '/users', label: '계정 관리', icon: 'users', perm: 'user.manage' },
  ] },
];

// 모바일 하단 탭: 자주 쓰는 화면만 (권한이 없는 탭은 빠진다). 나머지는 "더보기"(메뉴 서랍)에서.
const TABS = [
  { href: '/', label: '홈', icon: 'home', perm: 'view', exact: true },
  { href: '/scan/in', label: '입고', icon: 'in', perm: 'stock.in' },
  { href: '/scan/out', label: '출고', icon: 'out', perm: 'stock.out' },
  { href: '/products', label: '상품', icon: 'box', perm: 'view', not: ['/products/import'] },
  { href: '/orders', label: '주문', icon: 'cart', perm: 'view', not: ['/orders/import', '/orders/unmatched'] },
];

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* 무시 */ }
  }
  return out;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function createApp({ db, secureCookie = false, trustProxy = false, barcodeStrict = false }) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' http://127.0.0.1:9101 http://localhost:9101; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    // HTTPS 로 운영할 때만: 브라우저가 이 도메인에 항상 HTTPS 로 접속하게 한다.
    // includeSubDomains 는 쓰지 않는다 (같은 도메인의 다른 하위 사이트에 영향을 주지 않도록).
    if (secureCookie) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
  const assetV = assetVersion();
  app.use('/static', express.static(path.join(root, 'public'), {
    setHeaders: (res, file) => res.set('Cache-Control', res.req?.query?.v || file.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache'),
  }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    req.cookies = cookies;
    req.sid = cookies.sid || '';
    const s = loadSession(db, req.sid);
    req.user = s?.user ?? null;
    req.csrf = s?.csrf ?? '';

    const msg = typeof req.query.msg === 'string' ? req.query.msg.slice(0, 300) : '';
    Object.assign(res.locals, {
      ean13Svg, barcodeSvg, pwMin: minPasswordLength(), pageSize: pageSizeFor(req), user: req.user, csrf: req.csrf, ROLES, EVENT_LABEL, STATUS_LABEL, stockStatus, fmtTime,
      can: (perm) => Boolean(req.user && can(req.user.role, perm)),
      n: (v) => Number(v ?? 0).toLocaleString('ko-KR'),
      assetV,
      theme: ['light', 'dark'].includes(req.cookies?.theme) ? req.cookies.theme : '',
      msg, msgType: req.query.t === 'err' ? 'err' : 'ok',
      title: '', currentPath: req.path,
      tabs: TABS.filter((t) => req.user && can(req.user.role, t.perm)).map((t) => ({
        ...t,
        active: t.exact ? req.path === t.href : (req.path === t.href || req.path.startsWith(`${t.href}/`)) && !(t.not ?? []).some((x) => req.path.startsWith(x)),
      })),
      nav: NAV.map((g) => ({
        group: g.group,
        items: g.items.filter((i) => req.user && can(req.user.role, i.perm)).map((i) => ({
          ...i,
          active: i.exact ? req.path === i.href : (req.path === i.href || req.path.startsWith(`${i.href}/`)) && !(i.not ?? []).some((x) => req.path.startsWith(x)),
        })),
      })).filter((g) => g.items.length),
    });
    res.redirectWith = (url, message, type = 'ok') => {
      const sep = url.includes('?') ? '&' : '?';
      res.redirect(`${url}${sep}msg=${encodeURIComponent(String(message).slice(0, 300))}&t=${type}`);
    };
    next();
  });

  /** 로그인 + 권한 + (쓰기 요청이면) CSRF 토큰을 확인한다. perm 이 null 이면 로그인만 확인. */
  const guard = (perm = null) => (req, res, next) => {
    if (!req.user) {
      if (req.method === 'GET') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return res.status(401).render('error', { title: '로그인 필요', message: '로그인이 필요합니다.' });
    }
    if (req.user.mustChange && req.path !== '/password' && req.path !== '/logout') {
      if (req.method === 'GET') return res.redirectWith('/password', '비밀번호를 새로 정해야 계속 사용할 수 있습니다.', 'err');
      return res.status(403).render('error', { title: '비밀번호 변경 필요', message: '먼저 비밀번호를 새로 정해 주세요.' });
    }
    if (perm && !can(req.user.role, perm)) {
      return res.status(403).render('error', { title: '권한 없음', message: '이 기능을 사용할 권한이 없습니다. 관리자에게 문의하세요.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const token = req.get('x-csrf-token') || req.body?._csrf;
      if (!token || !safeEqual(token, req.csrf)) {
        return res.status(403).render('error', { title: '요청 거부', message: '화면이 오래되었거나 잘못된 요청입니다. 새로고침 후 다시 시도하세요.' });
      }
    }
    next();
  };

  const ctx = { db, guard, secureCookie, barcodeStrict };
  registerAuth(app, ctx);
  registerDashboard(app, ctx);
  registerProducts(app, ctx);
  registerStock(app, ctx);
  registerOrders(app, ctx);
  registerLabels(app, ctx);
  registerUsers(app, ctx);

  app.use((req, res) => {
    res.status(404).render('error', { title: '찾을 수 없음', message: '페이지를 찾을 수 없습니다.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof StockError || err instanceof ValidationError) {
      return res.status(400).render('error', { title: '처리할 수 없음', message: err.message });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).render('error', { title: '파일이 너무 큼', message: '파일이 너무 큽니다.' });
    }
    console.error('[오류]', req.method, req.path, err);
    res.status(500).render('error', { title: '오류', message: '서버에서 오류가 발생했습니다. 잠시 후 다시 시도하세요.' });
  });

  return app;
}
