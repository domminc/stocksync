import { labelTargets, markLabelsPrinted } from '../lib/products.js';
import { audit } from '../lib/auth.js';

const SIZES = {
  '50x30': '롤 라벨 50×30mm',
  '40x25': '롤 라벨 40×25mm',
  a4: 'A4 용지에 여러 장 (잘라 쓰기)',
};
const MAX_LABELS = 3000;
const FILTERS = { '': '전체', unprinted: '라벨 미출력만' };

const parseIds = (v) => [...new Set(String(v ?? '').split(',').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000);

export function registerLabels(app, { db, guard }) {
  app.get('/labels', guard('label.print'), (req, res) => {
    const ids = parseIds(req.query.ids);
    const q = String(req.query.q ?? '').slice(0, 100);
    const filter = Object.hasOwn(FILTERS, req.query.filter) ? String(req.query.filter) : '';
    const size = Object.hasOwn(SIZES, req.query.size) ? String(req.query.size) : '50x30';
    const copiesMode = req.query.copies === 'stock' ? 'stock' : 'fixed';
    const FIELD_MODES = ['price', 'price_name', 'barcode'];
    const askedLf = FIELD_MODES.includes(req.query.lf) ? req.query.lf : '';
    const lf = askedLf || (FIELD_MODES.includes(req.cookies?.llf) ? req.cookies.llf : 'price');
    if (askedLf) res.append('Set-Cookie', `llf=${askedLf}; Path=/; Max-Age=31536000; SameSite=Lax`);
    const asked = ['code128', 'ean13'].includes(req.query.bc) ? req.query.bc : '';
    const bc = asked || (['code128', 'ean13'].includes(req.cookies?.lbc) ? req.cookies.lbc : 'code128');
    if (asked) res.append('Set-Cookie', `lbc=${asked}; Path=/; Max-Age=31536000; SameSite=Lax`);
    const fixed = Math.min(Math.max(Number.parseInt(req.query.n, 10) || 1, 1), 50);

    const hasSelection = ids.length > 0 || q !== '' || filter !== '' || req.query.all === '1';
    const targets = hasSelection ? labelTargets(db, { ids, q, filter, limit: 1000 }) : [];
    let items = targets.map((p) => ({ p, count: copiesMode === 'stock' ? Math.max(p.qty, 0) : fixed }));
    let total = items.reduce((a, i) => a + i.count, 0);
    let truncated = false;
    if (total > MAX_LABELS) {
      truncated = true;
      let left = MAX_LABELS;
      items = items.map((i) => { const c = Math.min(i.count, left); left -= c; return { ...i, count: c }; }).filter((i) => i.count > 0);
      total = MAX_LABELS;
    }
    res.render('labels', {
      title: '라벨 인쇄', SIZES, FILTERS, size, copiesMode, fixed, bc, lf, q, filter, ids: ids.join(','), hasSelection,
      items, total, truncated, productCount: targets.length,
    });
  });

  app.post('/labels/printed', guard('label.print'), (req, res) => {
    const ids = parseIds(req.body.ids);
    if (!ids.length) return res.redirectWith('/labels', '출력 완료로 표시할 상품이 없습니다.', 'err');
    const n = markLabelsPrinted(db, ids);
    audit(db, req.user.id, 'label.printed', `${n} products`);
    res.redirectWith('/labels', `${n}개 상품을 라벨 출력 완료로 표시했습니다.`);
  });
}
