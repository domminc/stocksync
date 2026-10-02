-- 사용자 / 세션 / 감사
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','manager','staff','online','viewer')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  csrf       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE login_attempts (
  id       INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  ip       TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX idx_login_attempts_user ON login_attempts(username, at);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip, at);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER,
  action  TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT '',
  at      TEXT NOT NULL
);

-- 상품 / 재고
CREATE TABLE products (
  id           INTEGER PRIMARY KEY,
  sku_code     TEXT NOT NULL UNIQUE,
  barcode      TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  option_name  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',
  price        INTEGER,
  tracked      INTEGER NOT NULL DEFAULT 1,
  safety_stock INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_products_name ON products(name);

-- 매장·온라인 통합 단일 재고 풀. qty = 판매 가능 수량, hold = 보류(불량·검수 대기)
CREATE TABLE inventory (
  product_id INTEGER PRIMARY KEY REFERENCES products(id),
  qty        INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  hold       INTEGER NOT NULL DEFAULT 0 CHECK (hold >= 0),
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_inventory_qty ON inventory(qty);

-- 재고 원장: 추가만 가능 (수정·삭제 불가)
CREATE TABLE stock_ledger (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  event_type TEXT NOT NULL,
  qty_delta  INTEGER NOT NULL,
  hold_delta INTEGER NOT NULL DEFAULT 0,
  qty_after  INTEGER NOT NULL,
  hold_after INTEGER NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  ref_type   TEXT NOT NULL DEFAULT '',
  ref_id     TEXT NOT NULL DEFAULT '',
  user_id    INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ledger_product ON stock_ledger(product_id, id DESC);
CREATE INDEX idx_ledger_event ON stock_ledger(event_type, id DESC);

CREATE TRIGGER stock_ledger_no_update BEFORE UPDATE ON stock_ledger
BEGIN SELECT RAISE(ABORT, '재고 원장은 수정할 수 없습니다.'); END;
CREATE TRIGGER stock_ledger_no_delete BEFORE DELETE ON stock_ledger
BEGIN SELECT RAISE(ABORT, '재고 원장은 삭제할 수 없습니다.'); END;

-- 스캔 입고/출고 작업 (확정 전까지 임시 저장)
CREATE TABLE scan_sessions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  mode         TEXT NOT NULL CHECK (mode IN ('in','out')),
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','discarded')),
  created_at   TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE INDEX idx_scan_sessions_open ON scan_sessions(user_id, mode, status);

CREATE TABLE scan_lines (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES scan_sessions(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  UNIQUE (session_id, product_id)
);

-- 온라인 주문 (수량·상품 정보만 저장. 구매자/수령인 등 개인정보는 가져오지도 저장하지도 않는다)
-- status: pending 미출고 / shipped 출고확정(재고 차감됨) / canceled 취소 / returned 반품 처리 완료 /
--         closed 외부에서 이미 출고됨(재고 미반영)
CREATE TABLE order_lines (
  id           INTEGER PRIMARY KEY,
  order_no     TEXT NOT NULL,
  line_key     TEXT NOT NULL,
  channel      TEXT NOT NULL DEFAULT '',
  raw_code     TEXT NOT NULL DEFAULT '',
  item_name    TEXT NOT NULL DEFAULT '',
  product_id   INTEGER REFERENCES products(id),
  qty          INTEGER NOT NULL CHECK (qty > 0),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','shipped','canceled','returned','closed')),
  needs_return INTEGER NOT NULL DEFAULT 0,
  ordered_at   TEXT NOT NULL DEFAULT '',
  imported_at  TEXT NOT NULL,
  shipped_at   TEXT,
  UNIQUE (order_no, line_key)
);
CREATE INDEX idx_order_lines_pending ON order_lines(product_id, status, id);
CREATE INDEX idx_order_lines_status ON order_lines(status, id DESC);
CREATE INDEX idx_order_lines_unmatched ON order_lines(raw_code) WHERE product_id IS NULL;

-- 주문 파일의 상품코드를 우리 상품에 연결해 둔 기록 (다음 가져오기부터 자동 매칭)
CREATE TABLE code_aliases (
  raw_code   TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  created_at TEXT NOT NULL
);

CREATE TABLE import_batches (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  filename   TEXT NOT NULL DEFAULT '',
  user_id    INTEGER,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
