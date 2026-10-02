import { ROLES } from '../lib/permissions.js';
import {
  createUser, setPassword, validatePassword, generateTempPassword, destroyUserSessions, clearLoginFailures, lockedUsernames, audit,
} from '../lib/auth.js';
import { nowIso } from '../lib/time.js';
import { tx } from '../db.js';

const int = (v, d) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};

const ACTION_LABEL = {
  'user.create': '계정 생성', 'user.update': '계정 수정', 'user.reset': '비밀번호 초기화',
  'user.password': '비밀번호 지정', 'user.delete': '계정 삭제', 'user.unlock': '잠금 해제', 'password.change': '비밀번호 변경(본인)',
};

export function registerUsers(app, { db, guard }) {
  const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
  const find = (id) => db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);

  app.get('/users', guard('user.manage'), (req, res) => {
    const locked = lockedUsernames(db);
    const users = db.prepare(
      'SELECT id, username, display_name, role, active, must_change_password, created_at, last_login_at, password_changed_at FROM users WHERE deleted_at IS NULL ORDER BY id',
    ).all().map((u) => ({ ...u, locked: locked.has(u.username) }));
    const history = db.prepare(
      `SELECT a.action, a.detail, a.at, u.display_name AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.action LIKE 'user.%' OR a.action LIKE 'password.%' ORDER BY a.id DESC LIMIT 30`,
    ).all().map((h) => ({ ...h, label: ACTION_LABEL[h.action] || h.action }));
    res.render('users', { title: '계정 관리', users, history, me: req.user.id });
  });

  // 새 계정: 관리자가 임시 비밀번호를 정해 주면, 본인이 처음 로그인할 때 새로 정하게 한다.
  app.post('/users', guard('user.manage'), (req, res) => {
    const username = String(req.body.username ?? '').trim().toLowerCase();
    const displayName = String(req.body.display_name ?? '').trim().slice(0, 50);
    const role = String(req.body.role ?? '');
    const password = String(req.body.password ?? '');
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) return res.redirectWith('/users', '아이디는 영문 소문자·숫자·._- 3~32자로 입력하세요.', 'err');
    if (!displayName) return res.redirectWith('/users', '이름을 입력하세요.', 'err');
    if (!Object.hasOwn(ROLES, role)) return res.redirectWith('/users', '역할을 선택하세요.', 'err');
    const problem = validatePassword(password, { username });
    if (problem) return res.redirectWith('/users', problem, 'err');
    try {
      const id = createUser(db, { username, displayName, password, role, mustChange: true });
      audit(db, req.user.id, 'user.create', `${username} (${role}) #${id}`);
      res.redirectWith('/users', `${displayName} 계정을 만들었습니다. 첫 로그인 때 비밀번호를 새로 정하게 됩니다.`);
    } catch (e) {
      if (String(e.message).includes('users.username')) return res.redirectWith('/users', '이미 사용 중인 아이디입니다.', 'err');
      throw e;
    }
  });

  // 이름·역할·사용 여부
  app.post('/users/:id', guard('user.manage'), (req, res) => {
    const id = int(req.params.id, 0);
    const target = find(id);
    if (!target) return res.redirectWith('/users', '사용자를 찾을 수 없습니다.', 'err');
    const role = Object.hasOwn(ROLES, req.body.role) ? req.body.role : target.role;
    const active = req.body.active === '1' ? 1 : 0;
    const displayName = String(req.body.display_name ?? '').trim().slice(0, 50) || target.display_name;
    const losesAdmin = target.role === 'admin' && target.active === 1 && (role !== 'admin' || active === 0);
    if (losesAdmin && activeAdmins() <= 1) {
      return res.redirectWith('/users', '마지막 관리자는 역할을 바꾸거나 중지할 수 없습니다.', 'err');
    }
    db.prepare('UPDATE users SET display_name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?').run(displayName, role, active, nowIso(), id);
    if (!active || role !== target.role) destroyUserSessions(db, id); // 권한이 바뀌면 다시 로그인하게 한다
    audit(db, req.user.id, 'user.update', `${target.username} role=${role} active=${active}`);
    res.redirectWith('/users', `${displayName} 정보를 저장했습니다.`);
  });

  // 비밀번호 초기화: 임시 비밀번호를 만들어 이 화면에 한 번만 보여 준다 (주소·로그에 남기지 않기 위해 리다이렉트하지 않는다).
  app.post('/users/:id/reset', guard('user.manage'), (req, res) => {
    const id = int(req.params.id, 0);
    const target = find(id);
    if (!target) return res.redirectWith('/users', '사용자를 찾을 수 없습니다.', 'err');
    if (id === req.user.id) return res.redirectWith('/users', '내 비밀번호는 “비밀번호 변경”에서 바꾸세요.', 'err');
    const temp = generateTempPassword();
    setPassword(db, id, temp, { mustChange: true });
    clearLoginFailures(db, target.username);
    audit(db, req.user.id, 'user.reset', target.username);
    res.render('user_reset', { title: '비밀번호 초기화', target: { username: target.username, displayName: target.display_name }, temp });
  });

  // 비밀번호를 직접 정해 주기 (본인은 다음 로그인 때 새로 정해야 한다)
  app.post('/users/:id/password', guard('user.manage'), (req, res) => {
    const id = int(req.params.id, 0);
    const target = find(id);
    if (!target) return res.redirectWith('/users', '사용자를 찾을 수 없습니다.', 'err');
    if (id === req.user.id) return res.redirectWith('/users', '내 비밀번호는 “비밀번호 변경”에서 바꾸세요.', 'err');
    const password = String(req.body.password ?? '');
    const problem = validatePassword(password, { username: target.username });
    if (problem) return res.redirectWith('/users', problem, 'err');
    setPassword(db, id, password, { mustChange: true });
    clearLoginFailures(db, target.username);
    audit(db, req.user.id, 'user.password', target.username);
    res.redirectWith('/users', `${target.display_name}의 비밀번호를 지정했습니다. 다음 로그인 때 본인이 새로 정하게 됩니다.`);
  });

  // 계정 삭제: 재고 원장·기록에 이름이 남아야 하므로 행은 보존하고, 로그인 불가로 만든 뒤 목록에서 숨기며 아이디를 비운다.
  app.post('/users/:id/delete', guard('user.manage'), (req, res) => {
    const id = int(req.params.id, 0);
    const target = find(id);
    if (!target) return res.redirectWith('/users', '사용자를 찾을 수 없습니다.', 'err');
    if (id === req.user.id) return res.redirectWith('/users', '내 계정은 삭제할 수 없습니다.', 'err');
    if (String(req.body.confirm_username ?? '').trim().toLowerCase() !== target.username) {
      return res.redirectWith('/users', '삭제하려면 확인 칸에 계정 아이디를 정확히 입력하세요.', 'err');
    }
    if (target.role === 'admin' && target.active === 1 && activeAdmins() <= 1) {
      return res.redirectWith('/users', '마지막 관리자는 삭제할 수 없습니다.', 'err');
    }
    tx(db, () => {
      const now = nowIso();
      db.prepare("UPDATE users SET username = ?, active = 0, password_hash = '!deleted', must_change_password = 0, deleted_at = ?, updated_at = ? WHERE id = ?")
        .run(`~deleted~${id}~${target.username}`, now, now, id);
      destroyUserSessions(db, id);
      clearLoginFailures(db, target.username);
      db.prepare("UPDATE scan_sessions SET status = 'discarded' WHERE user_id = ? AND status = 'open'").run(id);
    });
    audit(db, req.user.id, 'user.delete', `${target.username} (${target.display_name})`);
    res.redirectWith('/users', `${target.display_name} 계정을 삭제했습니다. 이 사람이 남긴 재고 기록은 이름과 함께 그대로 보존됩니다.`);
  });

  app.post('/users/:id/unlock', guard('user.manage'), (req, res) => {
    const target = find(int(req.params.id, 0));
    if (!target) return res.redirectWith('/users', '사용자를 찾을 수 없습니다.', 'err');
    clearLoginFailures(db, target.username);
    audit(db, req.user.id, 'user.unlock', target.username);
    res.redirectWith('/users', `${target.display_name}의 로그인 잠금을 풀었습니다.`);
  });
}
