// 관리자(또는 다른 역할) 계정 만들기
//   npm run create-admin -- <아이디> "<이름>" [역할]
//   비밀번호는 안전을 위해 명령줄이 아니라 프롬프트(또는 STOCKSYNC_PASSWORD 환경변수)로 받는다.
import readline from 'node:readline';
import { openDb } from '../src/db.js';
import { createUser, validatePassword } from '../src/lib/auth.js';
import { ROLES } from '../src/lib/permissions.js';

const [username, displayName, role = 'admin'] = process.argv.slice(2);
if (!username || !displayName || !Object.hasOwn(ROLES, role)) {
  console.error(`사용법: npm run create-admin -- <아이디> "<이름>" [${Object.keys(ROLES).join('|')}]`);
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const password = process.env.STOCKSYNC_PASSWORD ?? await askHidden('비밀번호 (10자 이상): ');
const problem = validatePassword(password);
if (problem) { console.error(problem); process.exit(1); }

const db = openDb(process.env.DB_PATH || 'data/stocksync.db');
try {
  const id = createUser(db, { username: username.toLowerCase(), displayName, password, role });
  console.log(`계정을 만들었습니다: ${username.toLowerCase()} (${ROLES[role]}) #${id}`);
} catch (e) {
  console.error(String(e.message).includes('users.username') ? '이미 있는 아이디입니다.' : e.message);
  process.exit(1);
}
