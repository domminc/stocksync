import { ROLES } from '../lib/permissions.js';
import { createUser, hashPassword, validatePassword, destroyUserSessions, audit } from '../lib/auth.js';
import { nowIso } from '../lib/time.js';

const int = (v, d) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};

export function registerUsers(app, { db, guard }) {
  const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;

  app.get('/users', guard('user.manage'), (req, res) => {
    const users = db.prepare('SELECT id, username, display_name, role, active, created_at, last_login_at FROM users ORDER BY id').all();
    res.render('users', { title: '사용자 관리', users });
  });

  app.post('/users', guard('user.manage'), (req, res) => {
    const username = String(req.body.username ?? '').trim().toLowerCase();
    const displayName = String(req.body.display_name ?? '').trim().slice(0, 50);
    const role = String(req.body.role ?? '');
    const password = String(req.body.password ?? '');
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) return res.redirectWith('/users', '아이디는 영문 소문자·숫자·._- 3~32자로 입력하세요.', 'err');
    if (!displayName) return res.redirectWith('/users', '이름을 입력하세요.', 'err');
    if (!Object.hasOwn(ROLES, role)) return res.redirectWith('/users', '역할을 선택하세요.', 'err');
    const problem = validatePassword(password);
    if (problem) return res.redirectWith('/users', problem, 'err');
    try {
      const id = createUser(db, { username, displayName, password, role });
      audit(db, req.user.id, 'user.create', `${username} (${role}) #${id}`);
      res.redirectWith('/users', `${displayName} 계정을 만들었습니다.`);
    } catch (e) {
      if (String(e.message).includes('users.username')) return res.redirectWith('/users', '이미 사용 중인 아이디입니다.', 'err');
      throw e;
    }
  });

  app.post('/users/:id', guard('user.manage'), (req, res) => {
    const id = int(req.params.id, 0);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return res.redirectWith('/users', '사용자를 찾을 수 없습니다.', 'err');
    const role = Object.hasOwn(ROLES, req.body.role) ? req.body.role : target.role;
    const active = req.body.active === '1' ? 1 : 0;
    const displayName = String(req.body.display_name ?? '').trim().slice(0, 50) || target.display_name;
    const losesAdmin = target.role === 'admin' && target.active === 1 && (role !== 'admin' || active === 0);
    if (losesAdmin && activeAdmins() <= 1) {
      return res.redirectWith('/users', '마지막 관리자는 역할을 바꾸거나 중지할 수 없습니다.', 'err');
    }
    const newPassword = String(req.body.password ?? '');
    if (newPassword) {
      const problem = validatePassword(newPassword);
      if (problem) return res.redirectWith('/users', problem, 'err');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), id);
    }
    db.prepare('UPDATE users SET display_name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?').run(displayName, role, active, nowIso(), id);
    if (newPassword || !active || role !== target.role) destroyUserSessions(db, id); // 권한·비밀번호가 바뀌면 다시 로그인하게 한다
    audit(db, req.user.id, 'user.update', `#${id} role=${role} active=${active}${newPassword ? ' password-reset' : ''}`);
    res.redirectWith('/users', `${displayName} 정보를 저장했습니다.`);
  });
}
