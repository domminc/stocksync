-- 계정 관리: 관리자가 비밀번호를 정해 주거나 초기화한 계정은 다음 로그인 때 본인이 새 비밀번호를 정해야 한다.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;
