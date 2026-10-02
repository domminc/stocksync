import { findProductByCode } from '../lib/products.js';
import { applyBatch, findShortages, adjustTo, StockError } from '../lib/inventory.js';
import { tx } from '../db.js';
import { nowIso } from '../lib/time.js';
import { normalizeBarcode } from '../lib/ean13.js';
import { audit } from '../lib/auth.js';
import { pageSizeFor } from '../lib/pagesize.js';

const int = (v, d) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};

const MODE = {
  in: { perm: 'stock.in', label: '입고', event: 'IN', sign: 1 },
  out: { perm: 'stock.out', label: '출고', event: 'OUT', sign: -1 },
};

export function registerStock(app, { db, guard }) {
  /** 내 열린 스캔 작업을 가져오거나 없으면 새로 만든다. */
  const openSession = (userId, mode) => {
    const found = db.prepare("SELECT * FROM scan_sessions WHERE user_id = ? AND mode = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(userId, mode);
    if (found) return found;
    const r = db.prepare("INSERT INTO scan_sessions (user_id, mode, status, created_at) VALUES (?, ?, 'open', ?)").run(userId, mode, nowIso());
    return db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(Number(r.lastInsertRowid));
  };

  const ownSession = (req, res) => {
    const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(int(req.params.id, 0));
    if (!s || s.user_id !== req.user.id) {
      res.status(404).render('error', { title: '찾을 수 없음', message: '스캔 작업을 찾을 수 없습니다.' });
      return null;
    }
    // 작업 종류에 맞는 권한이 지금도 있는지 다시 확인한다.
    if (!res.locals.can(MODE[s.mode].perm)) {
      res.status(403).render('error', { title: '권한 없음', message: '이 기능을 사용할 권한이 없습니다.' });
      return null;
    }
    return s;
  };

  const lines = (sessionId) => db.prepare(
    `SELECT sl.id, sl.qty, p.id AS product_id, p.name, p.option_name, p.barcode, COALESCE(i.qty, 0) AS stock
       FROM scan_lines sl JOIN products p ON p.id = sl.product_id LEFT JOIN inventory i ON i.product_id = p.id
      WHERE sl.session_id = ? ORDER BY sl.id DESC`,
  ).all(sessionId);

  app.get('/scan/:mode', (req, res, next) => {
    const m = MODE[req.params.mode];
    if (!m) return next();
    return guard(m.perm)(req, res, () => {
      const s = openSession(req.user.id, req.params.mode);
      const ls = lines(s.id);
      res.render('scan', { title: `${m.label} 스캔`, s, m, lines: ls, totalQty: ls.reduce((a, l) => a + l.qty, 0) });
    });
  });

  app.post('/scan/:id/code', guard(), (req, res) => {
    const s = ownSession(req, res);
    if (!s) return;
    const back = `/scan/${s.mode}`;
    if (s.status !== 'open') return res.redirectWith(back, '이미 처리된 작업입니다.', 'err');
    const code = normalizeBarcode(req.body.code);
    if (!code) return res.redirect(back);
    const p = findProductByCode(db, code);
    if (!p) return res.redirectWith(back, `등록되지 않은 바코드입니다: ${code.slice(0, 40)}`, 'err');
    if (!p.tracked) return res.redirectWith(back, `재고 관리 대상이 아닌 상품입니다: ${p.name}`, 'err');
    if (!p.active) return res.redirectWith(back, `사용 중지된 상품입니다: ${p.name}`, 'err');
    db.prepare(
      `INSERT INTO scan_lines (session_id, product_id, qty) VALUES (?, ?, 1)
       ON CONFLICT(session_id, product_id) DO UPDATE SET qty = qty + 1`,
    ).run(s.id, p.id);
    const now = db.prepare('SELECT qty FROM scan_lines WHERE session_id = ? AND product_id = ?').get(s.id, p.id).qty;
    res.redirectWith(back, `${p.name}${p.option_name ? ` (${p.option_name})` : ''} · ${now}개`);
  });

  app.post('/scan/:id/line/:lineId', guard(), (req, res) => {
    const s = ownSession(req, res);
    if (!s) return;
    const back = `/scan/${s.mode}`;
    if (s.status !== 'open') return res.redirectWith(back, '이미 처리된 작업입니다.', 'err');
    const qty = int(req.body.qty, -1);
    if (qty < 0 || qty > 100000) return res.redirectWith(back, '수량은 0~100000 사이여야 합니다.', 'err');
    if (qty === 0) db.prepare('DELETE FROM scan_lines WHERE id = ? AND session_id = ?').run(int(req.params.lineId, 0), s.id);
    else db.prepare('UPDATE scan_lines SET qty = ? WHERE id = ? AND session_id = ?').run(qty, int(req.params.lineId, 0), s.id);
    res.redirect(back);
  });

  app.post('/scan/:id/discard', guard(), (req, res) => {
    const s = ownSession(req, res);
    if (!s) return;
    db.prepare("UPDATE scan_sessions SET status = 'discarded' WHERE id = ? AND status = 'open'").run(s.id);
    res.redirectWith(`/scan/${s.mode}`, '작업을 비웠습니다.');
  });

  app.post('/scan/:id/confirm', guard(), (req, res) => {
    const s = ownSession(req, res);
    if (!s) return;
    const back = `/scan/${s.mode}`;
    const m = MODE[s.mode];
    const note = String(req.body.note ?? '').trim().slice(0, 200);
    try {
      const result = tx(db, () => {
        const fresh = db.prepare('SELECT status FROM scan_sessions WHERE id = ?').get(s.id);
        if (fresh.status !== 'open') throw new StockError('BAD_STATE', '이미 처리된 작업입니다.');
        const ls = db.prepare('SELECT product_id, qty FROM scan_lines WHERE session_id = ?').all(s.id);
        if (!ls.length) throw new StockError('EMPTY', '스캔한 상품이 없습니다.');
        if (m.sign < 0) {
          const short = findShortages(db, ls.map((l) => ({ productId: l.product_id, qty: l.qty })));
          if (short.length) {
            const text = short.slice(0, 5).map((x) => `${x.name} (가용 ${x.have} / 필요 ${x.need})`).join(', ');
            throw new StockError('INSUFFICIENT', `재고가 부족해 확정하지 않았습니다: ${text}${short.length > 5 ? ` 외 ${short.length - 5}건` : ''}`);
          }
        }
        applyBatch(db, ls.map((l) => ({ productId: l.product_id, qtyDelta: m.sign * l.qty })), {
          eventType: m.event, reason: note, refType: 'scan_session', refId: s.id, userId: req.user.id,
        });
        db.prepare("UPDATE scan_sessions SET status = 'confirmed', confirmed_at = ?, note = ? WHERE id = ?").run(nowIso(), note, s.id);
        return { items: ls.length, qty: ls.reduce((a, l) => a + l.qty, 0) };
      });
      res.redirectWith(back, `${m.label} 확정: ${result.items}품목 ${result.qty}개`);
    } catch (e) {
      if (e instanceof StockError) return res.redirectWith(back, e.message, 'err');
      throw e;
    }
  });

  // 재고 조정 (실사 수량으로 맞추기)
  app.get('/adjust', guard('stock.adjust'), (req, res) => {
    const code = normalizeBarcode(req.query.code);
    const p = code ? findProductByCode(db, code) : null;
    const inv = p ? db.prepare('SELECT qty, hold FROM inventory WHERE product_id = ?').get(p.id) ?? { qty: 0, hold: 0 } : null;
    const notFound = Boolean(code && !p);
    res.render('adjust', { title: '재고 조정', code, p, inv, notFound });
  });

  app.post('/adjust', guard('stock.adjust'), (req, res) => {
    const productId = int(req.body.product_id, 0);
    try {
      const r = adjustTo(db, { productId, counted: int(req.body.counted, -1), reason: req.body.reason, userId: req.user.id });
      audit(db, req.user.id, 'stock.adjust', `${productId} delta=${r.delta}`);
      res.redirectWith('/adjust', r.changed ? `재고를 조정했습니다 (${r.delta > 0 ? '+' : ''}${r.delta}개).` : '수량이 같아 변경 없음.');
    } catch (e) {
      if (e instanceof StockError) {
        const p = db.prepare('SELECT barcode FROM products WHERE id = ?').get(productId);
        return res.redirectWith(`/adjust?code=${encodeURIComponent(p?.barcode ?? '')}`, e.message, 'err');
      }
      throw e;
    }
  });

  // 재고 원장
  app.get('/ledger', guard('view'), (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 64);
    const event = String(req.query.event ?? '');
    const page = Math.max(1, int(req.query.page, 1));
    const where = [];
    const params = [];
    if (q) {
      const p = findProductByCode(db, q);
      where.push('l.product_id = ?');
      params.push(p ? p.id : -1);
    }
    if (/^[A-Z_]+$/.test(event)) { where.push('l.event_type = ?'); params.push(event); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM stock_ledger l ${whereSql}`).get(...params).n;
    const size = pageSizeFor(req);
    const pages = Math.max(1, Math.ceil(total / size));
    const cur = Math.min(page, pages);
    const rows = db.prepare(
      `SELECT l.*, p.name, p.option_name, p.barcode, u.display_name AS user_name
         FROM stock_ledger l JOIN products p ON p.id = l.product_id LEFT JOIN users u ON u.id = l.user_id
         ${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    ).all(...params, size, (cur - 1) * size);
    const pageUrl = (n) => `/ledger?${new URLSearchParams({ q, event, page: String(n) })}`;
    res.render('ledger', { title: '재고 원장', q, event, result: { rows, total, page: cur, pages }, pageUrl });
  });
}
