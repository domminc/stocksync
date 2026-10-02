import express from 'express';
import {
  listProducts, getProduct, createProduct, updateProduct, importProducts, PRODUCT_CSV_TEMPLATE, ValidationError,
} from '../lib/products.js';
import { resolveHold } from '../lib/inventory.js';
import { decodeText, csvCell } from '../lib/csv.js';
import { audit } from '../lib/auth.js';

const int = (v, d) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};

const FILTERS = { '': '전체', out: '품절', low: '부족', hold: '보류 있음', risk: '주문 > 가용 (오버셀 위험)' };

const CSV_HEADER = ['바코드', '상품코드', '상품명', '옵션', '분류', '판매가', '안전재고', '재고관리', '가용재고', '보류', '미출고주문'];

export function registerProducts(app, { db, guard, barcodeStrict }) {
  app.get('/products', guard('view'), (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 100);
    const filter = Object.hasOwn(FILTERS, req.query.filter) ? String(req.query.filter) : '';
    const result = listProducts(db, { q, filter, page: int(req.query.page, 1), pageSize: 50 });
    const base = (page) => `/products?${new URLSearchParams({ q, filter, page: String(page) })}`;
    res.render('products', { title: '상품·재고', q, filter, FILTERS, result, pageUrl: base });
  });

  app.get('/products/export.csv', guard('view'), (req, res) => {
    const lines = [CSV_HEADER.join(',')];
    const stmt = db.prepare(
      `SELECT p.barcode, p.sku_code, p.name, p.option_name, p.category, p.price, p.safety_stock, p.tracked,
              COALESCE(i.qty, 0) AS qty, COALESCE(i.hold, 0) AS hold,
              (SELECT COALESCE(SUM(o.qty), 0) FROM order_lines o WHERE o.product_id = p.id AND o.status = 'pending') AS pending
         FROM products p LEFT JOIN inventory i ON i.product_id = p.id ORDER BY p.id`,
    );
    for (const r of stmt.iterate()) {
      lines.push([r.barcode, r.sku_code, r.name, r.option_name, r.category, r.price ?? '', r.safety_stock, r.tracked ? 'Y' : 'N', r.qty, r.hold, r.pending].map(csvCell).join(','));
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="stocksync-inventory.csv"' });
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  app.get('/products/import', guard('product.import'), (req, res) => {
    res.render('import', {
      title: '상품 가져오기', kind: 'products', url: '/products/import', templateUrl: '/products/import/template.csv',
      heading: '상품 가져오기 (CSV)',
      help: [
        '필수 열: 바코드, 상품명. 선택 열: 상품코드, 옵션, 분류, 판매가, 안전재고, 재고관리(Y/N), 현재고.',
        '이미 등록된 바코드는 상품 정보만 갱신하며 재고 수량은 바꾸지 않습니다.',
        '새 상품의 현재고는 “초기 재고”로 재고 원장에 기록됩니다.',
        '엑셀에서 저장할 때는 바코드 열을 텍스트 서식으로 두고 “CSV UTF-8”로 저장하세요. (숫자 서식이면 8.8E+12 처럼 변형됩니다.)',
      ],
    });
  });

  app.get('/products/import/template.csv', guard('product.import'), (req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="products-template.csv"' });
    res.send(`﻿${PRODUCT_CSV_TEMPLATE}`);
  });

  app.post('/products/import', express.raw({ type: () => true, limit: '100mb' }), guard('product.import'), (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new ValidationError('파일이 비어 있습니다.');
      const report = importProducts(db, decodeText(req.body), { userId: req.user.id, strict: barcodeStrict });
      audit(db, req.user.id, 'product.import', `created=${report.created} updated=${report.updated} skipped=${report.skipped}`);
      res.json({ ok: true, report });
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ ok: false, error: e.message });
      throw e;
    }
  });

  app.get('/products/new', guard('product.write'), (req, res) => {
    res.render('product_form', { title: '상품 등록', p: { tracked: 1, safety_stock: 0, active: 1 }, isNew: true });
  });

  app.post('/products', guard('product.write'), (req, res) => {
    try {
      const id = createProduct(db, formInput(req.body), { userId: req.user.id, strict: barcodeStrict });
      audit(db, req.user.id, 'product.create', String(id));
      res.redirectWith(`/products/${id}`, '상품을 등록했습니다.');
    } catch (e) {
      if (e instanceof ValidationError) {
        return res.status(400).render('product_form', { title: '상품 등록', p: formToRow(req.body), isNew: true, error: e.message });
      }
      throw e;
    }
  });

  app.get('/products/:id', guard('view'), (req, res) => {
    const p = getProduct(db, int(req.params.id, 0));
    if (!p) return res.status(404).render('error', { title: '찾을 수 없음', message: '상품을 찾을 수 없습니다.' });
    const ledger = db.prepare(
      `SELECT l.*, u.display_name AS user_name FROM stock_ledger l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.product_id = ? ORDER BY l.id DESC LIMIT 30`,
    ).all(p.id);
    const orders = db.prepare("SELECT * FROM order_lines WHERE product_id = ? AND status = 'pending' ORDER BY id LIMIT 20").all(p.id);
    res.render('product_show', { title: p.name, p, ledger, orders });
  });

  app.get('/products/:id/edit', guard('product.write'), (req, res) => {
    const p = getProduct(db, int(req.params.id, 0));
    if (!p) return res.status(404).render('error', { title: '찾을 수 없음', message: '상품을 찾을 수 없습니다.' });
    res.render('product_form', { title: '상품 수정', p, isNew: false });
  });

  app.post('/products/:id', guard('product.write'), (req, res) => {
    const id = int(req.params.id, 0);
    try {
      updateProduct(db, id, { ...formInput(req.body), active: req.body.active === '1' }, { strict: barcodeStrict });
      audit(db, req.user.id, 'product.update', String(id));
      res.redirectWith(`/products/${id}`, '상품 정보를 저장했습니다.');
    } catch (e) {
      if (e instanceof ValidationError) {
        return res.status(400).render('product_form', { title: '상품 수정', p: { ...formToRow(req.body), id }, isNew: false, error: e.message });
      }
      throw e;
    }
  });

  app.post('/products/:id/hold', guard('stock.adjust'), (req, res) => {
    const id = int(req.params.id, 0);
    const action = req.body.action === 'release' ? 'release' : 'discard';
    resolveHold(db, { productId: id, qty: int(req.body.qty, 0), action, reason: String(req.body.reason ?? '').slice(0, 200), userId: req.user.id });
    res.redirectWith(`/products/${id}`, action === 'release' ? '보류 재고를 판매 가능으로 되돌렸습니다.' : '보류 재고를 폐기 처리했습니다.');
  });
}

function formInput(b) {
  return {
    barcode: b.barcode, skuCode: b.sku_code, name: b.name, optionName: b.option_name, category: b.category,
    price: b.price, safetyStock: b.safety_stock, tracked: b.tracked === '1',
  };
}

function formToRow(b) {
  return {
    barcode: b.barcode ?? '', sku_code: b.sku_code ?? '', name: b.name ?? '', option_name: b.option_name ?? '', category: b.category ?? '',
    price: b.price ?? '', safety_stock: b.safety_stock ?? 0, tracked: b.tracked === '1' ? 1 : 0, active: b.active === '1' ? 1 : 0,
  };
}
