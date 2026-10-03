import express from 'express';
import { decodeText } from '../lib/csv.js';
import {
  importOrders, listOrders, shippableLineIds, listUnmatched, linkMatchKeyToProduct, ignoreMatchKey, rematchOrders, nextPendingLineForProduct, ORDER_CSV_TEMPLATE,
} from '../lib/orders.js';
import { findProductByCode, ValidationError } from '../lib/products.js';
import { shipOrderLine, shipMany, cancelPendingLine, returnOrderLine, StockError } from '../lib/inventory.js';
import { normalizeBarcode } from '../lib/ean13.js';
import { audit } from '../lib/auth.js';
import { pageSizeFor } from '../lib/pagesize.js';
import { can } from '../lib/permissions.js';

const int = (v, d) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};

export const ORDER_STATUS_LABEL = {
  pending: '미출고', shipped: '출고확정', canceled: '취소', returned: '반품 완료', closed: '외부 출고됨',
};
const FILTERS = {
  '': '전체', pending: '미출고', shipped: '출고확정', canceled: '취소', returned: '반품 완료', closed: '외부 출고됨',
  needs_return: '반품 필요', unmatched: '상품 미매칭',
};

const BULK_MAX = 2000; // 한 번에 처리하는 최대 건수 (넘으면 한 번 더 누르면 된다)

export function registerOrders(app, { db, guard }) {
  app.get('/orders', guard('view'), (req, res) => {
    const status = Object.hasOwn(FILTERS, req.query.status) ? String(req.query.status) : '';
    const q = String(req.query.q ?? '').slice(0, 100);
    const result = listOrders(db, { status, q, page: int(req.query.page, 1), pageSize: pageSizeFor(req) });
    const pageUrl = (n) => `/orders?${new URLSearchParams({ status, q, page: String(n) })}`;
    const bulkAll = (status === '' || status === 'pending') && req.user && can(req.user.role, 'order.ship') ? shippableLineIds(db, { q, limit: BULK_MAX + 1 }).length : 0;
    res.render('orders', { title: '주문 목록', status, q, FILTERS, ORDER_STATUS_LABEL, result, pageUrl, returnTo: pageUrl(result.page), bulkAll, BULK_MAX });
  });

  app.get('/orders/import', guard('order.import'), (req, res) => {
    res.render('import', {
      title: '주문 가져오기', kind: 'orders', url: '/orders/import', templateUrl: '/orders/import/template.csv',
      heading: '온라인 주문 가져오기 (CSV)',
      help: [
        '플레이오토 등에서 내려받은 주문 파일을 CSV(UTF-8 또는 엑셀 CSV)로 저장해 올리세요. 엑셀(.xlsx)은 “다른 이름으로 저장 → CSV”로 바꿉니다.',
        '필수 열: 주문번호, 수량, 그리고 상품코드(또는 바코드) 또는 상품명. 선택 열: 주문상품번호, 쇼핑몰, 주문상태, 주문일시.',
        '코드 열이 없으면 상품명(“상품명 / 옵션: 값”)을 상품 목록과 비교해 자동으로 연결합니다. 못 찾은 것은 “매칭 대기”에서 후보를 보고 한 번만 연결하면 이후 자동입니다.',
        '“┗(추가상품)” 같은 자수·각인 신청 줄은 재고와 무관한 항목으로 자동 제외됩니다.',
        '수령인·연락처·주소 같은 개인정보 열은 읽지도 저장하지도 않습니다.',
        '주문 접수만으로는 재고가 줄지 않습니다. “출고확정”을 할 때 재고가 차감됩니다.',
        '같은 파일을 다시 올려도 중복 등록되지 않습니다. 이미 출고된 주문(배송중 등)은 “외부 출고됨”으로 기록되어 재고에 반영되지 않습니다.',
      ],
    });
  });

  app.get('/orders/import/template.csv', guard('order.import'), (req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="orders-template.csv"' });
    res.send(`﻿${ORDER_CSV_TEMPLATE}`);
  });

  app.post('/orders/import', express.raw({ type: () => true, limit: '100mb' }), guard('order.import'), (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new ValidationError('파일이 비어 있습니다.');
      let filename = '';
      try { filename = decodeURIComponent(req.get('x-filename') || ''); } catch { /* 무시 */ }
      const report = importOrders(db, decodeText(req.body), { userId: req.user.id, filename });
      audit(db, req.user.id, 'order.import', `inserted=${report.inserted} dup=${report.duplicates} unmatched=${report.unmatched}`);
      res.json({ ok: true, report });
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ ok: false, error: e.message });
      throw e;
    }
  });

  app.get('/orders/unmatched', guard('order.match'), (req, res) => {
    res.render('unmatched', { title: '매칭 대기', rows: listUnmatched(db, { suggest: 40 }) });
  });

  app.post('/orders/unmatched/link', guard('order.match'), (req, res) => {
    // 후보 버튼은 product_id 를, 직접 입력은 바코드를 보낸다.
    const p = req.body.product_id
      ? db.prepare('SELECT id, name FROM products WHERE id = ? AND deleted_at IS NULL').get(int(req.body.product_id, 0))
      : findProductByCode(db, req.body.barcode);
    if (!p) return res.redirectWith('/orders/unmatched', `등록된 상품을 찾을 수 없습니다: ${normalizeBarcode(req.body.barcode).slice(0, 40)}`, 'err');
    const n = linkMatchKeyToProduct(db, req.body.key, p.id);
    audit(db, req.user.id, 'order.link', `${String(req.body.key).slice(0, 80)} -> ${p.id}`);
    res.redirectWith('/orders/unmatched', `${p.name}에 연결했습니다 (주문 ${n}건). 다음 가져오기부터 자동으로 연결됩니다.`);
  });

  app.post('/orders/unmatched/ignore', guard('order.match'), (req, res) => {
    const n = ignoreMatchKey(db, req.body.key);
    audit(db, req.user.id, 'order.ignore', String(req.body.key).slice(0, 80));
    res.redirectWith('/orders/unmatched', `재고와 무관한 항목으로 처리했습니다 (주문 ${n}건). 다음 가져오기부터 자동 제외됩니다.`);
  });

  app.post('/orders/unmatched/rematch', guard('order.match'), (req, res) => {
    res.redirectWith('/orders/unmatched', `다시 매칭: ${rematchOrders(db)}건 연결됨`);
  });

  // 포장하면서 상품 바코드를 스캔 → 가장 오래된 미출고 주문 한 줄을 출고확정
  app.get('/orders/ship', guard('order.ship'), (req, res) => {
    const recent = db.prepare(
      `SELECT l.created_at, l.qty_delta, l.qty_after, l.reason, p.name, p.option_name FROM stock_ledger l JOIN products p ON p.id = l.product_id
        WHERE l.event_type = 'ONLINE_SHIP' AND l.user_id = ? ORDER BY l.id DESC LIMIT 10`,
    ).all(req.user.id);
    const pending = db.prepare("SELECT COUNT(*) AS n FROM order_lines WHERE status = 'pending' AND product_id IS NOT NULL").get().n;
    res.render('ship', { title: '온라인 출고 스캔', recent, pending });
  });

  app.post('/orders/ship/scan', guard('order.ship'), (req, res) => {
    const code = normalizeBarcode(req.body.code);
    if (!code) return res.redirect('/orders/ship');
    const p = findProductByCode(db, code);
    if (!p) return res.redirectWith('/orders/ship', `등록되지 않은 바코드입니다: ${code.slice(0, 40)}`, 'err');
    const line = nextPendingLineForProduct(db, p.id);
    if (!line) return res.redirectWith('/orders/ship', `미출고 주문이 없는 상품입니다: ${p.name}`, 'err');
    try {
      const r = shipOrderLine(db, line.id, req.user.id);
      res.redirectWith('/orders/ship', `출고확정: ${line.order_no} · ${p.name} ${line.qty}개 (남은 재고 ${r.qty})`);
    } catch (e) {
      if (e instanceof StockError) return res.redirectWith('/orders/ship', e.message, 'err');
      throw e;
    }
  });

  const back = (req) => {
    const r = String(req.body.return_to ?? '');
    return r.startsWith('/orders') && !r.startsWith('//') ? r : '/orders';
  };

  // 일괄 출고확정: 체크한 주문(mode=selected) 또는 현재 검색 조건의 미출고 주문 전체(mode=all)
  app.post('/orders/ship-bulk', guard('order.ship'), (req, res) => {
    let ids;
    if (req.body.mode === 'all') {
      ids = shippableLineIds(db, { q: String(req.body.q ?? '').slice(0, 100), limit: BULK_MAX });
    } else {
      const raw = [].concat(req.body.ids ?? []);
      ids = [...new Set(raw.map((v) => int(v, 0)).filter((n) => n > 0))].sort((a, b) => a - b).slice(0, BULK_MAX);
    }
    if (!ids.length) return res.redirectWith(back(req), '출고확정할 주문이 없습니다. 체크박스로 주문을 선택하세요.', 'err');
    const { done, failed } = shipMany(db, ids, req.user.id);
    audit(db, req.user.id, 'order.ship_bulk', `mode=${req.body.mode === 'all' ? 'all' : 'selected'} shipped=${done.length} skipped=${failed.length}`);
    let msg = `${done.length}건 출고확정했습니다.`;
    if (failed.length) {
      const sample = failed.slice(0, 3).map((f) => f.orderNo).join(', ');
      msg += ` ${failed.length}건은 건너뛰었습니다(재고 부족·이미 처리됨 등): ${sample}${failed.length > 3 ? ' 외' : ''}`;
    }
    if (done.length === ids.length && ids.length === BULK_MAX) msg += ` 한 번에 ${BULK_MAX}건까지 처리합니다. 남은 주문은 한 번 더 실행하세요.`;
    res.redirectWith(back(req), msg, done.length ? 'ok' : 'err');
  });

  app.post('/orders/:id/ship', guard('order.ship'), (req, res) => {
    try {
      const r = shipOrderLine(db, int(req.params.id, 0), req.user.id);
      res.redirectWith(back(req), `출고확정: ${r.line.order_no} (남은 재고 ${r.qty})`);
    } catch (e) {
      if (e instanceof StockError) return res.redirectWith(back(req), e.message, 'err');
      throw e;
    }
  });

  app.post('/orders/:id/cancel', guard('order.ship'), (req, res) => {
    try {
      cancelPendingLine(db, int(req.params.id, 0));
      res.redirectWith(back(req), '주문을 취소 처리했습니다.');
    } catch (e) {
      if (e instanceof StockError) return res.redirectWith(back(req), e.message, 'err');
      throw e;
    }
  });

  app.post('/orders/:id/return', guard('order.return'), (req, res) => {
    try {
      returnOrderLine(db, int(req.params.id, 0), { condition: req.body.condition, userId: req.user.id });
      res.redirectWith(back(req), req.body.condition === 'good' ? '반품 입고 (양품): 판매 가능 재고에 추가' : '반품 입고 (불량): 보류 재고에 추가');
    } catch (e) {
      if (e instanceof StockError) return res.redirectWith(back(req), e.message, 'err');
      throw e;
    }
  });
}
