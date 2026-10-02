import { tx } from '../db.js';
import { nowIso } from './time.js';

export class StockError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'StockError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export const EVENT_LABEL = {
  INIT: '초기 재고',
  IN: '입고',
  OUT: '출고(매장)',
  ADJUST: '재고 조정',
  ONLINE_SHIP: '온라인 출고',
  RETURN_GOOD: '반품 입고(양품)',
  RETURN_BAD: '반품 입고(불량)',
  HOLD_RELEASE: '보류 해제',
  HOLD_DISCARD: '보류 폐기',
};

/**
 * 재고 한 건을 바꾸고 원장에 기록한다. 항상 트랜잭션 안에서 실행되며(중첩 가능),
 * 수량이 0 미만이 되면 아무것도 바꾸지 않고 StockError 를 던진다.
 * qty = 판매 가능 수량, hold = 보류 수량
 */
export function applyStock(db, { productId, qtyDelta = 0, holdDelta = 0, eventType, reason = '', refType = '', refId = '', userId = null, now = nowIso() }) {
  return tx(db, () => {
    const p = db.prepare('SELECT id, name, tracked FROM products WHERE id = ?').get(productId);
    if (!p) throw new StockError('NO_PRODUCT', '상품을 찾을 수 없습니다.');
    if (!p.tracked) throw new StockError('NOT_TRACKED', `재고 관리 대상이 아닌 상품입니다: ${p.name}`);

    let inv = db.prepare('SELECT qty, hold FROM inventory WHERE product_id = ?').get(productId);
    if (!inv) {
      db.prepare('INSERT INTO inventory (product_id, qty, hold, updated_at) VALUES (?, 0, 0, ?)').run(productId, now);
      inv = { qty: 0, hold: 0 };
    }
    const qty = inv.qty + qtyDelta;
    const hold = inv.hold + holdDelta;
    if (qty < 0) {
      throw new StockError('INSUFFICIENT', `재고 부족: ${p.name} (가용 ${inv.qty}개, 필요 ${-qtyDelta}개)`, { productId, have: inv.qty, need: -qtyDelta });
    }
    if (hold < 0) {
      throw new StockError('INSUFFICIENT_HOLD', `보류 재고 부족: ${p.name} (보류 ${inv.hold}개, 필요 ${-holdDelta}개)`, { productId });
    }
    db.prepare('UPDATE inventory SET qty = ?, hold = ?, updated_at = ? WHERE product_id = ?').run(qty, hold, now, productId);
    db.prepare(
      `INSERT INTO stock_ledger (product_id, event_type, qty_delta, hold_delta, qty_after, hold_after, reason, ref_type, ref_id, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(productId, eventType, qtyDelta, holdDelta, qty, hold, reason, refType, String(refId), userId, now);
    return { qty, hold };
  });
}

/** 여러 건을 한 번에 적용. 하나라도 실패하면 전부 취소된다. */
export function applyBatch(db, items, common) {
  return tx(db, () => items.map((it) => applyStock(db, { ...common, ...it })));
}

/** 출고 전에 부족한 상품을 한꺼번에 찾아 안내용 목록으로 돌려준다. items: [{productId, qty}] */
export function findShortages(db, items) {
  const q = db.prepare(
    `SELECT p.id, p.name, p.option_name, COALESCE(i.qty, 0) AS qty
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id WHERE p.id = ?`,
  );
  const out = [];
  for (const it of items) {
    const row = q.get(it.productId);
    if (row && row.qty < it.qty) out.push({ productId: row.id, name: row.name, option: row.option_name, have: row.qty, need: it.qty });
  }
  return out;
}

/** 실제로 센 수량에 맞춰 조정한다 (사유 필수). */
export function adjustTo(db, { productId, counted, reason, userId }) {
  if (!Number.isInteger(counted) || counted < 0) throw new StockError('BAD_INPUT', '실사 수량은 0 이상의 정수여야 합니다.');
  if (!String(reason ?? '').trim()) throw new StockError('BAD_INPUT', '조정 사유를 입력하세요.');
  return tx(db, () => {
    const inv = db.prepare('SELECT qty FROM inventory WHERE product_id = ?').get(productId) ?? { qty: 0 };
    const delta = counted - inv.qty;
    if (delta === 0) return { changed: false, delta: 0 };
    applyStock(db, { productId, qtyDelta: delta, eventType: 'ADJUST', reason: String(reason).trim(), refType: 'adjust', userId });
    return { changed: true, delta };
  });
}

/** 보류 재고를 판매 가능으로 되돌리거나(release) 폐기(discard)한다. */
export function resolveHold(db, { productId, qty, action, reason = '', userId }) {
  if (!Number.isInteger(qty) || qty <= 0) throw new StockError('BAD_INPUT', '수량은 1 이상의 정수여야 합니다.');
  if (action === 'release') {
    return applyStock(db, { productId, qtyDelta: qty, holdDelta: -qty, eventType: 'HOLD_RELEASE', reason, userId });
  }
  if (action === 'discard') {
    return applyStock(db, { productId, holdDelta: -qty, eventType: 'HOLD_DISCARD', reason, userId });
  }
  throw new StockError('BAD_INPUT', '처리 방법이 올바르지 않습니다.');
}

/** 온라인 주문 한 줄을 출고확정한다. 이때 처음으로 재고가 차감된다. */
export function shipOrderLine(db, lineId, userId) {
  return tx(db, () => {
    const line = db.prepare('SELECT * FROM order_lines WHERE id = ?').get(lineId);
    if (!line) throw new StockError('NO_LINE', '주문 내역을 찾을 수 없습니다.');
    if (line.status !== 'pending') throw new StockError('BAD_STATE', `이미 처리된 주문입니다 (${line.status}).`);
    if (!line.product_id) throw new StockError('UNMATCHED', '상품이 매칭되지 않은 주문입니다. 매칭 대기에서 먼저 연결하세요.');
    const now = nowIso();
    const res = applyStock(db, {
      productId: line.product_id, qtyDelta: -line.qty, eventType: 'ONLINE_SHIP',
      reason: `${line.channel} ${line.order_no}`.trim(), refType: 'order_line', refId: line.id, userId, now,
    });
    db.prepare("UPDATE order_lines SET status = 'shipped', shipped_at = ? WHERE id = ?").run(now, line.id);
    return { line, ...res };
  });
}

/** 출고 전 주문 취소 — 재고에는 영향이 없다. */
export function cancelPendingLine(db, lineId) {
  const r = db.prepare("UPDATE order_lines SET status = 'canceled' WHERE id = ? AND status = 'pending'").run(lineId);
  if (r.changes === 0) throw new StockError('BAD_STATE', '미출고 상태의 주문만 취소할 수 있습니다.');
}

/** 출고된 주문의 반품 입고. 양품은 판매 가능 재고로, 불량은 보류 재고로 들어간다. */
export function returnOrderLine(db, lineId, { condition, userId }) {
  return tx(db, () => {
    const line = db.prepare('SELECT * FROM order_lines WHERE id = ?').get(lineId);
    if (!line) throw new StockError('NO_LINE', '주문 내역을 찾을 수 없습니다.');
    if (line.status !== 'shipped') throw new StockError('BAD_STATE', '출고확정된 주문만 반품 입고할 수 있습니다.');
    if (condition !== 'good' && condition !== 'bad') throw new StockError('BAD_INPUT', '양품/불량을 선택하세요.');
    const good = condition === 'good';
    applyStock(db, {
      productId: line.product_id,
      qtyDelta: good ? line.qty : 0,
      holdDelta: good ? 0 : line.qty,
      eventType: good ? 'RETURN_GOOD' : 'RETURN_BAD',
      reason: `${line.channel} ${line.order_no}`.trim(), refType: 'order_line', refId: line.id, userId,
    });
    db.prepare("UPDATE order_lines SET status = 'returned', needs_return = 0 WHERE id = ?").run(line.id);
  });
}

export function stockStatus({ tracked, qty, safety }) {
  if (!tracked) return 'untracked';
  if (qty <= 0) return 'out';
  if (safety > 0 && qty <= safety) return 'low';
  return 'ok';
}

export const STATUS_LABEL = { ok: '정상', low: '부족', out: '품절', untracked: '관리 안 함' };
