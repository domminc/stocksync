import {
  verifyPassword, createSession, destroySession, isLoginLocked, recordLoginFailure,
  clearLoginFailures, burnPasswordCheck, validatePassword, setPassword, audit,
} from '../lib/auth.js';
import { nowIso } from '../lib/time.js';

function cookie(value, { secure, maxAgeSec }) {
  return `sid=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');

export function registerAuth(app, { db, guard, secureCookie }) {
  app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    res.render('login', { title: '로그인', next: safeNext(req.query.next), error: '' });
  });

  app.post('/login', (req, res) => {
    const username = String(req.body.username ?? '').trim().toLowerCase().slice(0, 64);
    const password = String(req.body.password ?? '').slice(0, 300);
    const next = safeNext(req.body.next);
    const ip = req.ip || 'unknown';
    const fail = (status, error) => res.status(status).render('login', { title: '로그인', next, error });

    if (isLoginLocked(db, username, ip)) return fail(429, '로그인 시도가 너무 많습니다. 15분 뒤에 다시 시도하세요.');
    const row = db.prepare('SELECT id, password_hash, active, must_change_password FROM users WHERE username = ?').get(username);
    if (!row || !row.active) {
      burnPasswordCheck(password);
      recordLoginFailure(db, username, ip);
      return fail(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    if (!verifyPassword(password, row.password_hash)) {
      recordLoginFailure(db, username, ip);
      return fail(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    clearLoginFailures(db, username);
    const s = createSession(db, row.id);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
    res.set('Set-Cookie', cookie(s.token, { secure: secureCookie, maxAgeSec: s.maxAgeSec }));
    res.redirect(row.must_change_password ? '/password' : next);
  });

  app.post('/logout', guard(), (req, res) => {
    destroySession(db, req.sid);
    res.set('Set-Cookie', cookie('', { secure: secureCookie, maxAgeSec: 0 }));
    res.redirect('/login');
  });

  app.get('/password', guard(), (req, res) => res.render('password', { title: '비밀번호 변경' }));

  app.post('/password', guard(), (req, res) => {
    const current = String(req.body.current ?? '');
    const next = String(req.body.next ?? '');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current, row.password_hash)) return res.redirectWith('/password', '현재 비밀번호가 올바르지 않습니다.', 'err');
    const problem = validatePassword(next, { username: req.user.username, current });
    if (problem) return res.redirectWith('/password', problem, 'err');
    if (String(req.body.confirm ?? next) !== next) return res.redirectWith('/password', '새 비밀번호 확인이 일치하지 않습니다.', 'err');
    setPassword(db, req.user.id, next, { mustChange: false }); // 다른 기기의 로그인은 모두 끊고, 이 기기는 새로 로그인시킨다
    const s = createSession(db, req.user.id);
    audit(db, req.user.id, 'password.change');
    res.set('Set-Cookie', cookie(s.token, { secure: secureCookie, maxAgeSec: s.maxAgeSec }));
    res.redirectWith('/', '비밀번호를 변경했습니다.');
  });
}
