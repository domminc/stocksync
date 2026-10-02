import crypto from 'node:crypto';
import { nowIso } from './time.js';

const SESSION_HOURS = 12;
const LOCK_WINDOW_MIN = 15;
const MAX_FAILS_PER_USER = 5;
const MAX_FAILS_PER_IP = 30;

/**
 * 비밀번호 최소 길이. 기본 10자. 서버 설정 PASSWORD_MIN_LENGTH 로 바꿀 수 있다 (6~64).
 * 짧게 쓸수록 추측하기 쉬워지므로 인터넷에 공개된 서버에서는 기본값 이상을 권장한다.
 */
export function minPasswordLength() {
  const n = Number.parseInt(process.env.PASSWORD_MIN_LENGTH ?? '', 10);
  return Number.isInteger(n) ? Math.min(Math.max(n, 6), 64) : 10;
}

/** 비밀번호 규칙: 최소 길이 이상, 아이디를 포함하지 않음, (변경 시) 현재 비밀번호와 달라야 함 */
export function validatePassword(pw, { username = '', current = null } = {}) {
  const min = minPasswordLength();
  if (typeof pw !== 'string' || pw.length < min) return `비밀번호는 ${min}자 이상이어야 합니다.`;
  if (pw.length > 200) return '비밀번호가 너무 깁니다.';
  const u = String(username).toLowerCase();
  if (u.length >= 3 && pw.toLowerCase().includes(u)) return '비밀번호에 아이디를 포함할 수 없습니다.';
  if (current !== null && pw === current) return '현재 비밀번호와 다른 비밀번호를 정해 주세요.';
  return null;
}

const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // 헷갈리는 글자(0 O 1 l I) 제외
/** 임시 비밀번호 12자 (읽기 쉽게 4자씩 '-' 로 구분). 예: Xk7p-Rm4q-Tz9b */
export function generateTempPassword() {
  let s = '';
  for (let i = 0; i < 12; i++) s += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
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
    `SELECT s.csrf, s.expires_at, u.id, u.username, u.display_name, u.role, u.active, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).get(sha(token));
  if (!row || !row.active || row.expires_at < nowIso()) return null;
  return {
    csrf: row.csrf,
    user: { id: row.id, username: row.username, displayName: row.display_name, role: row.role, mustChange: row.must_change_password === 1 },
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

/** mustChange=true 면 첫 로그인 때 비밀번호를 새로 정하게 한다 (관리자가 임시 비밀번호를 정해 준 계정). */
export function createUser(db, { username, displayName, password, role, mustChange = false }) {
  const now = nowIso();
  const r = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, role, active, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
  ).run(username, displayName, hashPassword(password), role, mustChange ? 1 : 0, now, now);
  return Number(r.lastInsertRowid);
}

/** 비밀번호 바꾸기. 로그인 중인 모든 기기는 로그아웃된다. mustChange=true 면 다음 로그인 때 본인이 다시 정해야 한다. */
export function setPassword(db, userId, password, { mustChange }) {
  const now = nowIso();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(password), mustChange ? 1 : 0, now, now, userId);
  destroyUserSessions(db, userId);
}

/** 로그인 실패로 잠긴(15분) 아이디 목록 */
export function lockedUsernames(db) {
  const since = new Date(Date.now() - LOCK_WINDOW_MIN * 60e3).toISOString();
  return new Set(db.prepare('SELECT username FROM login_attempts WHERE at > ? GROUP BY username HAVING COUNT(*) >= ?').all(since, MAX_FAILS_PER_USER).map((r) => r.username));
}
