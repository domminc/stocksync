import { openDb } from './db.js';
import { createApp } from './app.js';
import { createUser, purgeExpired, validatePassword } from './lib/auth.js';

const env = process.env;
const port = Number(env.PORT || 3000);
const host = env.HOST || '127.0.0.1';
const dbPath = env.DB_PATH || 'data/stocksync.db';

const db = openDb(dbPath);

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  const { ADMIN_USERNAME: username, ADMIN_PASSWORD: password } = env;
  const problem = password ? validatePassword(password) : '비밀번호가 없습니다.';
  if (username && !problem) {
    createUser(db, { username: username.toLowerCase(), displayName: '관리자', password, role: 'admin' });
    console.log(`[시작] 관리자 계정을 만들었습니다: ${username.toLowerCase()}`);
  } else {
    console.log('[시작] 사용자가 없습니다. 관리자를 만들려면 `npm run create-admin` 을 실행하거나 ADMIN_USERNAME / ADMIN_PASSWORD(10자 이상)를 설정하세요.');
  }
}

purgeExpired(db);
const timer = setInterval(() => purgeExpired(db), 60 * 60 * 1000);
timer.unref();

const app = createApp({
  db,
  secureCookie: env.SECURE_COOKIE === '1',
  trustProxy: env.TRUST_PROXY === '1',
  barcodeStrict: env.BARCODE_STRICT === '1',
});

const server = app.listen(port, host, () => {
  console.log(`[시작] StockSync http://${host}:${port}  (DB: ${dbPath})`);
});

function shutdown(signal) {
  console.log(`[종료] ${signal} 수신, 마무리합니다.`);
  server.close(() => {
    try { db.close(); } catch { /* 이미 닫힘 */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
