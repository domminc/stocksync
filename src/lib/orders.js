import { tx } from '../db.js';
import { nowIso } from './time.js';
import { parseCsv, resolveColumns, normHeader } from './csv.js';
import { normalizeBarcode } from './ean13.js';
import { ValidationError } from './products.js';

/**
 * 주문 파일에서 읽는 열은 아래 목록뿐이다. 구매자·수령인·연락처·주소·결제 정보 열은
 * 이름이 무엇이든 읽지도 저장하지도 않는다 (개인정보 최소 수집).
 * 앞에 있는 이름일수록 우선한다 — 상품코드 열이 여러 개면 바코드가 먼저 쓰인다.
 */
const ORDER_COLUMNS = {
  orderNo: ['주문번호', '쇼핑몰주문번호', '플레이오토주문번호', '주문번호1', 'orderno', 'orderid'],
  lineId: ['주문상품번호', '상품주문번호', '주문순번', '주문상세번호', 'lineid'],
  channel: ['쇼핑몰', '쇼핑몰명', '채널', '판매처', '마켓', 'channel'],
  code: ['바코드', '판매자관리코드', '자체상품코드', '관리코드', '상품코드', '쇼핑몰상품코드', '옵션코드', 'sku'],
  name: ['상품명', '주문상품명', 'itemname'],
  qty: ['수량', '주문수량', 'qty', 'quantity'],
  status: ['주문상태', '상태', '처리상태', 'status'],
  orderedAt: ['주문일시', '주문일', '결제일시', '결제일', 'orderedat'],
};

export const ORDER_CSV_TEMPLATE =
  '주문번호,주문상품번호,쇼핑몰,바코드,상품명,수량,주문상태,주문일시\n' +
  '2026100200001,1,스마트스토어,8800000000015,샘플 야구글러브 빨강/L,1,신규주문,2026-10-02 09:12\n';

/** 원본 주문상태 문구를 이 시스템의 상태로 바꾼다. 배송 준비 단계와 이미 나간 단계를 구분한다. */
export function mapSourceStatus(raw) {
  const t = normHeader(raw);
  if (!t) return 'pending';
  if (/취소|cancel/.test(t)) return 'canceled';
  if (/반품|환불|교환|return|refund/.test(t)) return 'claim';
  if (/신규|결제완료|입금|배송준비|출고대기|출고예정|발주|주문접수|상품준비|준비중|new|paid/.test(t)) return 'pending';
  if (/배송중|배송완료|출고|발송|구매확정|송장|배송|shipped|delivered/.test(t)) return 'closed';
  return 'pending';
}

/** 주문 파일의 상품코드를 상품에 연결 (바코드 → 상품코드 → 연결 기록). */
export function matchProductId(db, rawCode) {
  const code = normalizeBarcode(rawCode);
  if (!code) return null;
  const r =
    db.prepare('SELECT id FROM products WHERE barcode = ?').get(code) ??
    db.prepare('SELECT id FROM products WHERE sku_code = ?').get(code) ??
    db.prepare('SELECT product_id AS id FROM code_aliases WHERE raw_code = ?').get(code);
  return r ? r.id : null;
}

export function importOrders(db, text, { userId = null, filename = '' } = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ValidationError('데이터 행이 없습니다. 첫 줄은 제목 행이어야 합니다.');
  const cols = resolveColumns(rows[0], ORDER_COLUMNS);
  const missing = [];
  if (cols.orderNo === undefined) missing.push('주문번호');
  if (cols.qty === undefined) missing.push('수량');
  if (cols.code === undefined && cols.name === undefined) missing.push('상품코드(또는 바코드) / 상품명');
  if (missing.length) {
    throw new ValidationError(`필요한 열을 찾지 못했습니다: ${missing.join(', ')}. 파일의 제목 행: ${rows[0].map((h) => h.trim()).join(', ')}`);
  }
  const cell = (r, f) => String(cols[f] === undefined ? '' : (r[cols[f]] ?? '')).trim();

  const report = {
    total: 0, inserted: 0, duplicates: 0, canceledUpdated: 0, closedUpdated: 0, needsReturn: 0,
    pendingNew: 0, closedNew: 0, canceledNew: 0, unmatched: 0, rematched: 0,
    errors: [], errorsTruncated: false, usedCodeColumn: cols.code === undefined ? null : rows[0][cols.code].trim(),
  };
  const addError = (row, message) => {
    if (report.errors.length < 200) report.errors.push({ row, message });
    else report.errorsTruncated = true;
  };

  tx(db, () => {
    const now = nowIso();
    const find = db.prepare('SELECT id, status, product_id, raw_code FROM order_lines WHERE order_no = ? AND line_key = ?');
    const insert = db.prepare(
      `INSERT INTO order_lines (order_no, line_key, channel, raw_code, item_name, product_id, qty, status, needs_return, ordered_at, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    const seq = new Map();
    for (let n = 1; n < rows.length; n++) {
      const r = rows[n];
      if (r.every((c) => String(c).trim() === '')) continue;
      report.total++;
      const lineNo = n + 1;
      const orderNo = cell(r, 'orderNo');
      if (!orderNo) { addError(lineNo, '주문번호가 비어 있습니다.'); continue; }
      const qtyText = cell(r, 'qty').replace(/,/g, '');
      const qty = /^\d+$/.test(qtyText) ? Number(qtyText) : NaN;
      if (!Number.isInteger(qty) || qty <= 0) { addError(lineNo, `수량이 올바르지 않습니다 (${cell(r, 'qty') || '비어 있음'}).`); continue; }
      const rawCode = normalizeBarcode(cell(r, 'code'));
      const itemName = cell(r, 'name').slice(0, 200);
      if (!rawCode && !itemName) { addError(lineNo, '상품코드와 상품명이 모두 비어 있습니다.'); continue; }

      let lineKey = cell(r, 'lineId');
      if (!lineKey) {
        const base = `${orderNo}|${rawCode || itemName}`;
        const k = (seq.get(base) ?? 0) + 1;
        seq.set(base, k);
        lineKey = `${rawCode || itemName}#${k}`;
      }
      const source = mapSourceStatus(cell(r, 'status'));
      const existing = find.get(orderNo, lineKey);

      if (!existing) {
        const productId = matchProductId(db, rawCode);
        const status = source === 'canceled' ? 'canceled' : source === 'pending' ? 'pending' : 'closed';
        insert.run(orderNo, lineKey, cell(r, 'channel').slice(0, 50), rawCode, itemName, productId, qty, status, cell(r, 'orderedAt').slice(0, 40), now);
        report.inserted++;
        if (status === 'pending') report.pendingNew++;
        else if (status === 'closed') report.closedNew++;
        else report.canceledNew++;
        if (!productId && status === 'pending') report.unmatched++;
        continue;
      }

      let changed = false;
      if (existing.status === 'pending' && source === 'canceled') {
        db.prepare("UPDATE order_lines SET status = 'canceled' WHERE id = ?").run(existing.id);
        report.canceledUpdated++; changed = true;
      } else if (existing.status === 'pending' && source === 'closed') {
        db.prepare("UPDATE order_lines SET status = 'closed' WHERE id = ?").run(existing.id);
        report.closedUpdated++; changed = true;
      } else if (existing.status === 'shipped' && (source === 'canceled' || source === 'claim')) {
        db.prepare('UPDATE order_lines SET needs_return = 1 WHERE id = ? AND needs_return = 0').run(existing.id);
        report.needsReturn++; changed = true;
      }
      if (!existing.product_id && rawCode) {
        const productId = matchProductId(db, rawCode);
        if (productId) {
          db.prepare('UPDATE order_lines SET product_id = ?, raw_code = ? WHERE id = ?').run(productId, rawCode, existing.id);
          report.rematched++; changed = true;
        }
      }
      if (!changed) report.duplicates++;
    }
    db.prepare('INSERT INTO import_batches (kind, filename, user_id, summary, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('orders', filename.slice(0, 200), userId, JSON.stringify({ ...report, errors: undefined }), now);
  });
  return report;
}

/** 아직 상품이 연결되지 않은 주문을 상품 등록/연결 기록 기준으로 다시 매칭한다. */
export function rematchOrders(db) {
  return tx(db, () => {
    const rows = db.prepare("SELECT DISTINCT raw_code FROM order_lines WHERE product_id IS NULL AND raw_code <> ''").all();
    const upd = db.prepare('UPDATE order_lines SET product_id = ? WHERE product_id IS NULL AND raw_code = ?');
    let matched = 0;
    for (const { raw_code: code } of rows) {
      const id = matchProductId(db, code);
      if (id) matched += Number(upd.run(id, code).changes);
    }
    return matched;
  });
}

/** 주문 파일의 코드를 특정 상품에 연결해 기억해 둔다. 같은 코드의 기존 주문도 함께 연결된다. */
export function linkCodeToProduct(db, rawCode, productId) {
  const code = normalizeBarcode(rawCode);
  if (!code) throw new ValidationError('연결할 코드가 비어 있습니다.');
  const p = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!p) throw new ValidationError('상품을 찾을 수 없습니다.');
  return tx(db, () => {
    db.prepare('INSERT INTO code_aliases (raw_code, product_id, created_at) VALUES (?, ?, ?) ON CONFLICT(raw_code) DO UPDATE SET product_id = excluded.product_id')
      .run(code, productId, nowIso());
    return Number(db.prepare('UPDATE order_lines SET product_id = ? WHERE product_id IS NULL AND raw_code = ?').run(productId, code).changes);
  });
}

export function listUnmatched(db) {
  return db.prepare(
    `SELECT raw_code, MIN(item_name) AS item_name, COUNT(*) AS lines, SUM(qty) AS qty, MIN(channel) AS channel
       FROM order_lines WHERE product_id IS NULL AND status = 'pending'
      GROUP BY raw_code, CASE WHEN raw_code = '' THEN item_name ELSE '' END
      ORDER BY lines DESC LIMIT 200`,
  ).all();
}

export function listOrders(db, { status = '', q = '', page = 1, pageSize = 50 } = {}) {
  const where = [];
  const params = [];
  if (status === 'needs_return') where.push('o.needs_return = 1');
  else if (status === 'unmatched') where.push("o.product_id IS NULL AND o.status = 'pending'");
  else if (['pending', 'shipped', 'canceled', 'returned', 'closed'].includes(status)) { where.push('o.status = ?'); params.push(status); }
  const term = String(q).trim();
  if (term) {
    where.push("(o.order_no = ? OR o.raw_code = ? OR o.item_name LIKE ? ESCAPE '\\')");
    params.push(term, normalizeBarcode(term), `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM order_lines o ${whereSql}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(1, page), pages);
  const rows = db.prepare(
    `SELECT o.*, p.name AS product_name, p.option_name, p.barcode, COALESCE(i.qty, 0) AS stock_qty
       FROM order_lines o LEFT JOIN products p ON p.id = o.product_id LEFT JOIN inventory i ON i.product_id = o.product_id
       ${whereSql} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, pageSize, (cur - 1) * pageSize);
  return { rows, total, page: cur, pages, pageSize };
}

/** 포장하면서 스캔 → 해당 상품의 가장 오래된 미출고 주문 한 줄을 출고확정 대상으로 찾는다. */
export function nextPendingLineForProduct(db, productId) {
  return db.prepare("SELECT * FROM order_lines WHERE product_id = ? AND status = 'pending' ORDER BY id LIMIT 1").get(productId) ?? null;
}
