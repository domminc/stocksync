import crypto from 'node:crypto';
import { tx } from '../db.js';
import { nowIso } from './time.js';
import { parseCsv, resolveColumns } from './csv.js';
import { normalizeBarcode, isAcceptableBarcode, isValidEan13, looksLikeExcelDamage } from './ean13.js';
import { applyStock } from './inventory.js';
import { issueBarcode } from './barcodes.js';
import { makeNameKey } from './namekey.js';

export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

const PRODUCT_COLUMNS = {
  barcode: ['바코드', '상품바코드', 'barcode', 'ean', 'ean13'],
  sku: ['판매자관리코드', '상품코드', 'sku코드', '자체상품코드', '품목코드', '옵션코드', '관리코드', 'sku'],
  name: ['상품명', '쇼핑몰상품명', '품명', 'name'],
  option: ['옵션', '옵션명', '옵션내용', '옵션상세', 'option'],
  category: ['분류', '카테고리', 'category'],
  price: ['판매가', '판매가격', '가격', 'price'],
  safety: ['안전재고', 'safety'],
  tracked: ['재고관리', '재고관리여부', 'tracked'],
  stock: ['현재고', '현재재고', '초기재고', '재고수량', '재고', 'stock'],
};

export const PRODUCT_CSV_TEMPLATE =
  '바코드,상품코드,상품명,옵션,분류,판매가,안전재고,재고관리,현재고\n' +
  ',GLV-001-RD-L,샘플 야구글러브,빨강/L,글러브,89000,5,Y,12\n' +
  '8800000000015,GLV-002,바코드가 이미 있는 상품,,글러브,59000,0,Y,3\n';

const parseYesNo = (v, fallback = true) => {
  const t = String(v ?? '').trim().toLowerCase();
  if (t === '') return fallback;
  if (['n', 'no', '0', 'false', '아니오', '미관리', 'x'].includes(t)) return false;
  return true;
};

const parseIntStrict = (v) => {
  const t = String(v ?? '').replace(/[,\s원]/g, '');
  if (t === '') return null;
  if (!/^-?\d+$/.test(t)) return NaN;
  return Number(t);
};

/** 코드도 바코드도 없는 행의 고정 상품코드: 같은 상품명+옵션이면 항상 같은 값이라 다시 올려도 중복되지 않는다. */
export const derivedSku = (nameKey) => `N-${crypto.createHash('sha1').update(nameKey).digest('hex').slice(0, 16)}`;

/** 사람이 입력한 상품 정보를 검사해 저장 가능한 값으로 바꾼다. 문제가 있으면 ValidationError. 바코드는 비어 있을 수 있다(자동 발급). */
export function cleanProductInput(input, { strict = false } = {}) {
  const barcode = normalizeBarcode(input.barcode);
  if (barcode) {
    if (looksLikeExcelDamage(barcode)) throw new ValidationError(`바코드가 엑셀에서 지수 표기로 변형되었습니다 (${barcode}). 열 서식을 '텍스트'로 바꿔 다시 저장하세요.`);
    if (!isAcceptableBarcode(barcode)) throw new ValidationError(`바코드 형식이 올바르지 않습니다 (${barcode}).`);
    if (strict && /^\d{13}$/.test(barcode) && !isValidEan13(barcode)) throw new ValidationError(`EAN-13 체크디지트가 맞지 않습니다 (${barcode}).`);
  }
  const name = String(input.name ?? '').trim();
  if (!name) throw new ValidationError('상품명을 입력하세요.');
  if (name.length > 300) throw new ValidationError('상품명이 너무 깁니다.');
  const skuCode = String(input.skuCode ?? '').trim();
  if (skuCode.length > 64) throw new ValidationError('상품코드가 너무 깁니다.');
  const price = input.price === null || input.price === undefined || input.price === '' ? null : parseIntStrict(input.price);
  if (Number.isNaN(price) || (price !== null && price < 0)) throw new ValidationError('판매가는 0 이상의 숫자여야 합니다.');
  const safety = input.safetyStock === undefined || input.safetyStock === '' ? 0 : parseIntStrict(input.safetyStock);
  if (safety === null || Number.isNaN(safety) || safety < 0) throw new ValidationError('안전재고는 0 이상의 숫자여야 합니다.');
  const optionName = String(input.optionName ?? '').trim().slice(0, 200);
  return {
    barcode, skuCode, name, optionName,
    category: String(input.category ?? '').trim().slice(0, 100),
    price, safetyStock: safety,
    tracked: input.tracked === undefined ? 1 : (input.tracked ? 1 : 0),
    nameKey: makeNameKey(name, optionName),
  };
}

function uniqueMessage(e) {
  const m = String(e?.message ?? '');
  if (m.includes('products.barcode')) return '이미 등록된 바코드입니다.';
  if (m.includes('products.sku_code')) return '이미 등록된 상품코드입니다.';
  return null;
}

/** 바코드를 비워 두면 자체 EAN-13 을 발급한다. 상품코드를 비우면 바코드와 같게 한다. */
export function createProduct(db, input, { strict = false } = {}) {
  const c = cleanProductInput(input, { strict });
  const now = nowIso();
  try {
    return tx(db, () => {
      const barcode = c.barcode || issueBarcode(db);
      const r = db.prepare(
        `INSERT INTO products (sku_code, barcode, name, option_name, category, price, tracked, safety_stock, active, name_key, barcode_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      ).run(c.skuCode || barcode, barcode, c.name, c.optionName, c.category, c.price, c.tracked, c.safetyStock, c.nameKey, c.barcode ? 'external' : 'issued', now, now);
      const id = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO inventory (product_id, qty, hold, updated_at) VALUES (?, 0, 0, ?)').run(id, now);
      return id;
    });
  } catch (e) {
    const msg = uniqueMessage(e);
    if (msg) throw new ValidationError(msg);
    throw e;
  }
}

export function updateProduct(db, id, input, { strict = false } = {}) {
  const c = cleanProductInput(input, { strict });
  if (!c.barcode) throw new ValidationError('바코드는 비울 수 없습니다.');
  try {
    const old = db.prepare('SELECT barcode, barcode_source FROM products WHERE id = ?').get(id);
    if (!old) throw new ValidationError('상품을 찾을 수 없습니다.');
    const source = old.barcode === c.barcode ? old.barcode_source : 'external';
    db.prepare(
      `UPDATE products SET sku_code = ?, barcode = ?, name = ?, option_name = ?, category = ?, price = ?, tracked = ?,
              safety_stock = ?, active = ?, name_key = ?, barcode_source = ?, updated_at = ? WHERE id = ?`,
    ).run(c.skuCode || c.barcode, c.barcode, c.name, c.optionName, c.category, c.price, c.tracked, c.safetyStock, input.active === false ? 0 : 1, c.nameKey, source, nowIso(), id);
  } catch (e) {
    const msg = uniqueMessage(e);
    if (msg) throw new ValidationError(msg);
    throw e;
  }
}

/** 시작할 때 한 번: 이름 키가 비어 있는 기존 상품의 키를 채운다. */
export function backfillNameKeys(db) {
  const rows = db.prepare("SELECT id, name, option_name FROM products WHERE name_key = ''").all();
  if (!rows.length) return 0;
  const upd = db.prepare('UPDATE products SET name_key = ? WHERE id = ?');
  tx(db, () => { for (const r of rows) upd.run(makeNameKey(r.name, r.option_name), r.id); });
  return rows.length;
}

/** 스캔한 값(바코드 → 상품코드 → 연결해 둔 코드 순)으로 상품을 찾는다. */
export function findProductByCode(db, rawCode) {
  const code = normalizeBarcode(rawCode);
  if (!code) return null;
  return (
    db.prepare('SELECT * FROM products WHERE barcode = ?').get(code) ??
    db.prepare('SELECT * FROM products WHERE sku_code = ?').get(code) ??
    db.prepare('SELECT p.* FROM code_aliases a JOIN products p ON p.id = a.product_id WHERE a.raw_code = ?').get(code) ??
    null
  );
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const FROM = 'FROM products p LEFT JOIN inventory i ON i.product_id = p.id';

function buildWhere({ q = '', filter = '' }) {
  const where = [];
  const params = [];
  const term = String(q).trim();
  if (term) {
    where.push("(p.barcode = ? OR p.sku_code = ? OR p.name LIKE ? ESCAPE '\\' OR p.option_name LIKE ? ESCAPE '\\')");
    params.push(normalizeBarcode(term), term, `%${escapeLike(term)}%`, `%${escapeLike(term)}%`);
  }
  if (filter === 'out') where.push('p.active = 1 AND p.tracked = 1 AND COALESCE(i.qty, 0) = 0');
  else if (filter === 'low') where.push('p.active = 1 AND p.tracked = 1 AND p.safety_stock > 0 AND COALESCE(i.qty, 0) > 0 AND COALESCE(i.qty, 0) <= p.safety_stock');
  else if (filter === 'hold') where.push('COALESCE(i.hold, 0) > 0');
  else if (filter === 'unprinted') where.push('p.label_printed_at IS NULL AND p.active = 1');
  else if (filter === 'inactive') where.push('p.active = 0');
  else if (filter === 'risk') {
    where.push(`p.active = 1 AND p.tracked = 1 AND (SELECT COALESCE(SUM(o.qty), 0) FROM order_lines o WHERE o.product_id = p.id AND o.status = 'pending') > COALESCE(i.qty, 0)`);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** 상품 목록 검색 (바코드·상품코드 정확히 일치 또는 상품명/옵션 포함). 10만 건에서도 페이지 단위로만 읽는다. */
export function listProducts(db, { q = '', filter = '', page = 1, pageSize = 50 } = {}) {
  const { whereSql, params } = buildWhere({ q, filter });
  const total = db.prepare(`SELECT COUNT(*) AS n ${FROM} ${whereSql}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(1, page), pages);
  const rows = db.prepare(
    `SELECT p.id, p.sku_code, p.barcode, p.name, p.option_name, p.category, p.price, p.tracked, p.safety_stock, p.active, p.label_printed_at,
            COALESCE(i.qty, 0) AS qty, COALESCE(i.hold, 0) AS hold,
            (SELECT COALESCE(SUM(o.qty), 0) FROM order_lines o WHERE o.product_id = p.id AND o.status = 'pending') AS pending
       ${FROM} ${whereSql} ORDER BY p.id LIMIT ? OFFSET ?`,
  ).all(...params, pageSize, (cur - 1) * pageSize);
  return { rows, total, page: cur, pages, pageSize };
}

export const SAFETY_MAX = 1000000;

/** 안전재고 값 검사: 0 이상 정수 */
export function parseSafetyStock(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,7}$/.test(s) || Number(s) > SAFETY_MAX) throw new ValidationError(`안전재고는 0 이상 ${SAFETY_MAX.toLocaleString('ko-KR')} 이하의 숫자여야 합니다.`);
  return Number(s);
}

/** 상품 1개의 안전재고만 바꾼다 */
export function setSafetyStock(db, id, value) {
  const n = parseSafetyStock(value);
  const r = db.prepare('UPDATE products SET safety_stock = ?, updated_at = ? WHERE id = ?').run(n, nowIso(), id);
  return Number(r.changes) > 0 ? n : null;
}

/** 검색·보기 조건에 맞는 모든 상품의 안전재고를 한 번에 바꾼다. 바뀐 상품 수를 돌려준다. */
export function setSafetyStockMany(db, { q = '', filter = '' } = {}, value) {
  const n = parseSafetyStock(value);
  const { whereSql, params } = buildWhere({ q, filter });
  const r = db.prepare(`UPDATE products SET safety_stock = ?, updated_at = ? WHERE id IN (SELECT p.id ${FROM} ${whereSql})`).run(n, nowIso(), ...params);
  return { value: n, count: Number(r.changes) };
}

/** 검색·보기 조건에 맞는 상품을 한 번에 사용 중지/재사용한다. 재고·주문 기록은 그대로 남는다. */
export function setActiveMany(db, { q = '', filter = '' } = {}, active) {
  const { whereSql, params } = buildWhere({ q, filter });
  const r = db.prepare(`UPDATE products SET active = ?, updated_at = ? WHERE id IN (SELECT p.id ${FROM} ${whereSql})`).run(active ? 1 : 0, nowIso(), ...params);
  return { count: Number(r.changes) };
}

/** 체크한 상품들(ids)에 안전재고/사용 여부를 적용한다. 바뀐 개수를 돌려준다. */
export function updateSelected(db, ids, { safety, active } = {}) {
  const list = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000);
  if (!list.length) return { count: 0 };
  const marks = list.map(() => '?').join(',');
  const now = nowIso();
  if (safety !== undefined) {
    const n = parseSafetyStock(safety);
    return { count: Number(db.prepare(`UPDATE products SET safety_stock = ?, updated_at = ? WHERE id IN (${marks})`).run(n, now, ...list).changes), value: n };
  }
  return { count: Number(db.prepare(`UPDATE products SET active = ?, updated_at = ? WHERE id IN (${marks})`).run(active ? 1 : 0, now, ...list).changes) };
}

/** 라벨을 인쇄할 상품들: ids 가 있으면 그 상품, 없으면 검색 조건에 맞는 상품 (최대 limit 개) */
export function labelTargets(db, { ids = [], q = '', filter = '', limit = 1000 } = {}) {
  const select = `SELECT p.id, p.barcode, p.name, p.option_name, p.sku_code, p.price, p.label_printed_at, COALESCE(i.qty, 0) AS qty ${FROM}`;
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    return db.prepare(`${select} WHERE p.id IN (${marks}) ORDER BY p.id LIMIT ?`).all(...ids, limit);
  }
  const { whereSql, params } = buildWhere({ q, filter });
  return db.prepare(`${select} ${whereSql} ORDER BY p.id LIMIT ?`).all(...params, limit);
}

export function markLabelsPrinted(db, ids) {
  const now = nowIso();
  const upd = db.prepare('UPDATE products SET label_printed_at = ? WHERE id = ?');
  return tx(db, () => ids.reduce((n, id) => n + Number(upd.run(now, id).changes), 0));
}

export function getProduct(db, id) {
  return db.prepare(
    `SELECT p.*, COALESCE(i.qty, 0) AS qty, COALESCE(i.hold, 0) AS hold,
            (SELECT COALESCE(SUM(o.qty), 0) FROM order_lines o WHERE o.product_id = p.id AND o.status = 'pending') AS pending
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id WHERE p.id = ?`,
  ).get(id);
}

/** 주문 후보 제안: 주문 상품 문구의 단어로 상품을 찾는다 (모델 번호 같은 단어를 우선) */
export function suggestProducts(db, tokens, limit = 5) {
  if (!tokens.length) return [];
  const query = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
  try {
    return db.prepare(
      `SELECT p.id, p.name, p.option_name, p.barcode, p.sku_code
         FROM products_fts f JOIN products p ON p.id = f.rowid
        WHERE products_fts MATCH ? ORDER BY bm25(products_fts) LIMIT ?`,
    ).all(query, limit);
  } catch {
    return [];
  }
}

/**
 * 상품 CSV 가져오기. 올바른 행만 반영하고, 문제 행은 줄 번호와 이유를 보고서로 돌려준다.
 * - 바코드 열이 비어 있으면 자체 EAN-13 을 발급한다 (같은 상품코드 또는 같은 상품명+옵션이면 다시 올려도 새로 발급하지 않음).
 * - 이미 있는 상품은 정보만 갱신(재고 수량은 건드리지 않음), 새 상품의 '현재고'는 초기 재고로 원장에 기록한다.
 */
export function importProducts(db, text, { userId = null, strict = false } = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ValidationError('데이터 행이 없습니다. 첫 줄은 제목 행이어야 합니다.');
  const cols = resolveColumns(rows[0], PRODUCT_COLUMNS);
  if (cols.name === undefined) {
    throw new ValidationError(`'상품명' 열이 필요합니다. 찾은 제목: ${rows[0].map((h) => h.trim()).join(', ')}`);
  }
  const cell = (r, f) => (cols[f] === undefined ? '' : (r[cols[f]] ?? ''));

  const report = {
    total: 0, created: 0, updated: 0, skipped: 0, initialStock: 0, barcodesIssued: 0, checkDigitWarnings: 0,
    errors: [], errorsTruncated: false, hasBarcodeColumn: cols.barcode !== undefined, hasSkuColumn: cols.sku !== undefined,
  };
  const addError = (row, message) => {
    report.skipped++;
    if (report.errors.length < 200) report.errors.push({ row, message });
    else report.errorsTruncated = true;
  };

  tx(db, () => {
    const byBarcode = db.prepare('SELECT id, sku_code FROM products WHERE barcode = ?');
    const bySku = db.prepare('SELECT id, barcode FROM products WHERE sku_code = ?');
    const insertP = db.prepare(
      `INSERT INTO products (sku_code, barcode, name, option_name, category, price, tracked, safety_stock, active, name_key, barcode_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    );
    const updateP = db.prepare(
      `UPDATE products SET sku_code = ?, name = ?, option_name = ?, category = ?, price = ?, tracked = ?, safety_stock = ?, name_key = ?, updated_at = ? WHERE id = ?`,
    );
    const insertInv = db.prepare('INSERT INTO inventory (product_id, qty, hold, updated_at) VALUES (?, 0, 0, ?)');
    const now = nowIso();
    const seen = new Set();

    for (let n = 1; n < rows.length; n++) {
      const r = rows[n];
      if (r.every((c) => String(c).trim() === '')) continue;
      report.total++;
      const lineNo = n + 1;
      let c;
      try {
        c = cleanProductInput({
          barcode: cell(r, 'barcode'), skuCode: cell(r, 'sku'), name: cell(r, 'name'), optionName: cell(r, 'option'),
          category: cell(r, 'category'), price: cell(r, 'price'), safetyStock: cell(r, 'safety'),
          tracked: parseYesNo(cell(r, 'tracked')),
        }, { strict });
      } catch (e) {
        if (e instanceof ValidationError) { addError(lineNo, e.message); continue; }
        throw e;
      }
      const sku = c.skuCode || c.barcode || derivedSku(c.nameKey);
      const identity = c.barcode ? `b:${c.barcode}` : `s:${sku}`;
      if (seen.has(identity)) {
        addError(lineNo, c.barcode ? `파일 안에서 바코드가 중복됩니다 (${c.barcode}).` : `파일 안에서 같은 상품이 중복됩니다 (${c.skuCode ? `상품코드 ${sku}` : `${c.name} / ${c.optionName || '옵션 없음'}`}). 상품코드 열을 추가하면 구분할 수 있습니다.`);
        continue;
      }
      seen.add(identity);
      if (/^\d{13}$/.test(c.barcode) && !isValidEan13(c.barcode)) report.checkDigitWarnings++;

      const stockRaw = parseIntStrict(cell(r, 'stock'));
      if (Number.isNaN(stockRaw) || (stockRaw !== null && stockRaw < 0)) { addError(lineNo, '현재고는 0 이상의 숫자여야 합니다.'); continue; }

      const owner = bySku.get(sku);
      let existing = c.barcode ? byBarcode.get(c.barcode) : null;
      if (c.barcode && owner && owner.barcode !== c.barcode) { addError(lineNo, `상품코드 ${sku} 는 다른 바코드(${owner.barcode})에서 이미 사용 중입니다.`); continue; }
      if (!c.barcode && owner) existing = owner;

      if (existing) {
        updateP.run(sku, c.name, c.optionName, c.category, c.price, c.tracked, c.safetyStock, c.nameKey, now, existing.id);
        report.updated++;
      } else {
        const barcode = c.barcode || issueBarcode(db);
        if (!c.barcode) report.barcodesIssued++;
        const res = insertP.run(sku, barcode, c.name, c.optionName, c.category, c.price, c.tracked, c.safetyStock, c.nameKey, c.barcode ? 'external' : 'issued', now, now);
        const id = Number(res.lastInsertRowid);
        insertInv.run(id, now);
        report.created++;
        if (stockRaw && c.tracked) {
          applyStock(db, { productId: id, qtyDelta: stockRaw, eventType: 'INIT', reason: '상품 가져오기 초기 재고', refType: 'import', userId, now });
          report.initialStock++;
        }
      }
    }
    db.prepare('INSERT INTO import_batches (kind, filename, user_id, summary, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('products', '', userId, JSON.stringify({ ...report, errors: undefined }), now);
  });
  return report;
}

/** 대시보드 숫자 */
export function dashboardStats(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const products = one('SELECT COUNT(*) AS n, SUM(tracked) AS tracked FROM products WHERE active = 1');
  const totals = one('SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(hold), 0) AS hold FROM inventory');
  const out = one('SELECT COUNT(*) AS n FROM products p LEFT JOIN inventory i ON i.product_id = p.id WHERE p.active = 1 AND p.tracked = 1 AND COALESCE(i.qty, 0) = 0').n;
  const low = one('SELECT COUNT(*) AS n FROM products p JOIN inventory i ON i.product_id = p.id WHERE p.active = 1 AND p.tracked = 1 AND p.safety_stock > 0 AND i.qty > 0 AND i.qty <= p.safety_stock').n;
  const pending = one("SELECT COALESCE(SUM(qty), 0) AS qty, COUNT(*) AS lines FROM order_lines WHERE status = 'pending'");
  const risk = one(
    `SELECT COUNT(*) AS n FROM (
       SELECT o.product_id FROM order_lines o LEFT JOIN inventory i ON i.product_id = o.product_id
        WHERE o.status = 'pending' AND o.product_id IS NOT NULL
        GROUP BY o.product_id HAVING SUM(o.qty) > COALESCE(MAX(i.qty), 0))`,
  ).n;
  const unmatched = one("SELECT COUNT(*) AS n FROM order_lines WHERE product_id IS NULL AND status = 'pending'").n;
  const needsReturn = one('SELECT COUNT(*) AS n FROM order_lines WHERE needs_return = 1').n;
  const unprinted = one('SELECT COUNT(*) AS n FROM products WHERE label_printed_at IS NULL AND active = 1').n;
  const recent = db.prepare(
    `SELECT l.id, l.product_id, l.event_type, l.qty_delta, l.hold_delta, l.qty_after, l.created_at, p.name, p.option_name, p.barcode, u.display_name AS user_name
       FROM stock_ledger l JOIN products p ON p.id = l.product_id LEFT JOIN users u ON u.id = l.user_id
      ORDER BY l.id DESC LIMIT 8`,
  ).all();
  return {
    productCount: products.n, trackedCount: products.tracked ?? 0,
    totalQty: totals.qty, totalHold: totals.hold, outCount: out, lowCount: low,
    pendingQty: pending.qty, pendingLines: pending.lines, riskCount: risk, unmatchedCount: unmatched, needsReturnCount: needsReturn,
    unprintedCount: unprinted, recent,
  };
}
