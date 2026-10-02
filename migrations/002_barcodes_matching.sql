-- 자체 바코드 발급 / 라벨 출력 / 상품명 기반 주문 매칭

ALTER TABLE products ADD COLUMN barcode_source TEXT NOT NULL DEFAULT 'external'; -- external 기존 바코드, issued 이 시스템이 발급
ALTER TABLE products ADD COLUMN name_key TEXT NOT NULL DEFAULT '';               -- 상품명+옵션을 정규화한 매칭용 키
ALTER TABLE products ADD COLUMN label_printed_at TEXT;
CREATE INDEX idx_products_name_key ON products(name_key);
CREATE INDEX idx_products_unprinted ON products(id) WHERE label_printed_at IS NULL;

-- 자체 발급 바코드 일련번호 (EAN-13: 접두 20 + 일련번호 10자리 + 체크디지트)
CREATE TABLE barcode_counter (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  next_serial INTEGER NOT NULL
);
INSERT INTO barcode_counter (id, next_serial) VALUES (1, 1);

-- 주문 줄: 코드가 없는 주문 파일은 상품명 키로 매칭한다. match_key = 상품코드 또는 'NAME:' + name_key
ALTER TABLE order_lines ADD COLUMN name_key TEXT NOT NULL DEFAULT '';
ALTER TABLE order_lines ADD COLUMN match_key TEXT NOT NULL DEFAULT '';
UPDATE order_lines SET match_key = raw_code WHERE raw_code <> '';
CREATE INDEX idx_order_lines_match ON order_lines(match_key) WHERE product_id IS NULL;

-- “재고와 무관” 으로 표시한 주문 항목 (자수 신청 같은 추가상품 등). 이후 가져오기에서 자동으로 제외된다.
CREATE TABLE ignored_keys (
  match_key  TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- 상품 검색(후보 제안)용 전문 검색 색인
CREATE VIRTUAL TABLE products_fts USING fts5(name, option_name, sku_code, content='products', content_rowid='id', tokenize='unicode61');
INSERT INTO products_fts(products_fts) VALUES ('rebuild');

CREATE TRIGGER products_fts_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, name, option_name, sku_code) VALUES (new.id, new.name, new.option_name, new.sku_code);
END;
CREATE TRIGGER products_fts_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, option_name, sku_code) VALUES ('delete', old.id, old.name, old.option_name, old.sku_code);
END;
CREATE TRIGGER products_fts_au AFTER UPDATE OF name, option_name, sku_code ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, option_name, sku_code) VALUES ('delete', old.id, old.name, old.option_name, old.sku_code);
  INSERT INTO products_fts(rowid, name, option_name, sku_code) VALUES (new.id, new.name, new.option_name, new.sku_code);
END;
