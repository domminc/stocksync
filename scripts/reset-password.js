// 서버에서 직접 비밀번호를 초기화한다. 관리자가 한 명뿐인데 비밀번호를 잊었을 때 쓴다.
//   npm run reset-password -- jiny
// 임시 비밀번호가 화면에 한 번 출력되고, 그 계정은 다음 로그인 때 새 비밀번호를 정해야 한다.
import { openDb } from '../src/db.js';
import { generateTempPassword, setPassword, clearLoginFailures, audit } from '../src/lib/auth.js';

const username = (process.argv[2] || '').trim().toLowerCase();
if (!username) {
  console.error('사용법: npm run reset-password -- <아이디>');
  process.exit(1);
}
const db = openDb(process.env.DB_PATH || 'data/stocksync.db');
const user = db.prepare('SELECT id, display_name, active FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`계정을 찾을 수 없습니다: ${username}`);
  process.exit(1);
}
const temp = generateTempPassword();
setPassword(db, user.id, temp, { mustChange: true });
clearLoginFailures(db, username);
audit(db, null, 'user.reset', `${username} (서버에서 초기화)`);
console.log(`${user.display_name} (@${username}) 의 임시 비밀번호: ${temp}`);
if (!user.active) console.log('주의: 이 계정은 사용 중지 상태입니다. 로그인하려면 관리자가 “사용”을 켜야 합니다.');
console.log('로그인하면 새 비밀번호를 정하게 됩니다. 이 화면을 닫으면 다시 볼 수 없습니다.');
