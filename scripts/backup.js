// DB 백업: 서비스를 멈추지 않고 일관된 복사본을 만들고 오래된 백업을 정리한다.
//   npm run backup            (cron 에서 하루 1회 이상 실행 권장)
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';

const dbPath = process.env.DB_PATH || 'data/stocksync.db';
const dir = process.env.BACKUP_DIR || 'backups';
const keep = Number(process.env.BACKUP_KEEP || 14);

if (!fs.existsSync(dbPath)) { console.error(`DB 파일이 없습니다: ${dbPath}`); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const target = path.resolve(dir, `stocksync-${stamp}.db`);
const db = openDb(dbPath);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
console.log(`백업 완료: ${target}`);

const old = fs.readdirSync(dir).filter((f) => /^stocksync-.*\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) { fs.unlinkSync(path.join(dir, f)); console.log(`오래된 백업 삭제: ${f}`); }
