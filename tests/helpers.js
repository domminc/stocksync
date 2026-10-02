import { openDb } from '../src/db.js';
import { createUser } from '../src/lib/auth.js';
import { createProduct } from '../src/lib/products.js';
import { ean13CheckDigit } from '../src/lib/ean13.js';

export function memDb() {
  return openDb(':memory:');
}

/** 12자리 앞부분으로 올바른 EAN-13 만들기 */
export function ean(n) {
  const first12 = String(880000000000 + n).padStart(12, '0');
  return first12 + ean13CheckDigit(first12);
}

export function addProduct(db, n, extra = {}) {
  return createProduct(db, { barcode: ean(n), skuCode: `SKU-${n}`, name: `테스트상품 ${n}`, ...extra });
}

export function addUser(db, role = 'admin', username = role, password = 'correct-horse-battery') {
  return createUser(db, { username, displayName: `${role} 사용자`, password, role });
}

export const PASSWORD = 'correct-horse-battery';
