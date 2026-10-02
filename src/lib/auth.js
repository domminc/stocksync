import crypto from 'node:crypto';
import { nowIso } from './time.js';

const SESSION_HOURS = 12;
const LOCK_WINDOW_MIN = 15;
const MAX_FAILS_PER_USER = 5;
const MAX_FAILS_PER_IP = 30;

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return '비밀번호는 10자 이상이어야 합니다.';
  if (pw.length > 200) return '비밀번호가 너무 깁니다.';
  return null;
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [alg, n, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

// 존재하지 않는 계정도 같은 시간이 걸리도록 사용하는 더미 해시
const DUMMY_HASH = hashPassword('dummy-password-for-timing');
export function burnPasswordCheck(pw) {
  verifyPassword(pw, DUMMY_HASH);
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_HOURS * 3600 * 1000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha(token), userId, csrf, now.toISOString(), expires.toISOString());
  return { token, csrf, maxAgeSec: SESSION_HOURS * 3600 };
}

export function loadSession(db, token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const row = db.prepare(
    `SELECT s.csrf, s.expires_at, u.id, u.username, u.display_name, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).get(sha(token));
  if (!row || !row.active || row.expires_at < nowIso()) return null;
  return {
    csrf: row.csrf,
    user: { id: row.id, username: row.username, displayName: row.display_name, role: row.role },
  };
}

export const destroySession = (db, token) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token || ''));
export const destroyUserSessions = (db, userId) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
export const purgeExpired = (db) => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  db.prepare('DELETE FROM login_attempts WHERE at < ?').run(new Date(Date.now() - 24 * 3600e3).toISOString());
};

/** 로그인 시도 제한: 같은 계정 5회 / 같은 IP 30회 실패 시 15분간 잠금 */
export function isLoginLocked(db, username, ip) {
  const since = new Date(Date.now() - LOCK_WINDOW_MIN * 60e3).toISOString();
  const byUser = db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND at > ?').get(username, since).n;
  const byIp = db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ?').get(ip, since).n;
  return byUser >= MAX_FAILS_PER_USER || byIp >= MAX_FAILS_PER_IP;
}
export const recordLoginFailure = (db, username, ip) =>
  db.prepare('INSERT INTO login_attempts (username, ip, at) VALUES (?, ?, ?)').run(username, ip, nowIso());
export const clearLoginFailures = (db, username) =>
  db.prepare('DELETE FROM login_attempts WHERE username = ?').run(username);

export function audit(db, userId, action, detail = '') {
  db.prepare('INSERT INTO audit_log (user_id, action, detail, at) VALUES (?, ?, ?, ?)').run(userId, action, String(detail).slice(0, 500), nowIso());
}

export function createUser(db, { username, displayName, password, role }) {
  const now = nowIso();
  const r = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
  ).run(username, displayName, hashPassword(password), role, now, now);
  return Number(r.lastInsertRowid);
}
