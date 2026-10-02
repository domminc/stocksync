-- 계정 삭제: 재고 원장·감사 기록에 “누가 했는지”가 남아 있으므로 행을 지우지 않고,
-- 로그인할 수 없게 만든 뒤 목록에서 숨기고 아이디를 다시 쓸 수 있게 비운다.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
