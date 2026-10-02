// Hostinger VPS(Docker Manager + Traefik)에 StockSync 를 배포한다. GitHub Actions 에서 실행한다.
//   HOSTINGER_API_KEY            (필수, GitHub Secrets)
//   STOCKSYNC_ADMIN_PASSWORD     (선택, GitHub Secrets) 사용자가 없을 때 첫 관리자 계정을 만드는 데만 쓰인다
//   GITHUB_SHA / GITHUB_REPOSITORY  Actions 가 채워 준다. 이 커밋의 소스를 컨테이너가 직접 내려받아 실행한다(공개 저장소 전제).
// 비밀번호·API 키는 로그에 출력하지 않는다.
import { pathToFileURL } from 'node:url';

const VM_ID = process.env.HOSTINGER_VM_ID || '1952316';
const API_ROOT = `https://developers.hostinger.com/api/vps/v1/virtual-machines/${VM_ID}`;
export const PROJECT = 'stocksync';
export const DOMAIN = process.env.STOCKSYNC_DOMAIN || 'jejubaseball.com';

export function certificateResolver(traefikCompose) {
  const m = /--certificatesresolvers\.([a-zA-Z0-9_-]+)\./.exec(String(traefikCompose || ''));
  return m ? m[1] : '';
}

// 서버 컨테이너가 실행할 compose. 비밀값은 ${...} 로 두고 값은 프로젝트 환경변수로 따로 보낸다.
export function composeContent({ repository, sha, domain = DOMAIN, resolver = 'letsencrypt' }) {
  const url = `https://codeload.github.com/${repository}/tar.gz/${sha}`;
  const fetchCode = "fetch(process.env.SRC_URL).then(r=>{if(!r.ok)throw new Error('download '+r.status);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync('/tmp/s.tgz',Buffer.from(b)))";
  const health = "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))";
  const resolverLabel = resolver
    ? `      - "traefik.http.routers.stocksync.tls.certresolver=${resolver}"\n` : '';
  return `services:
  stocksync:
    image: node:22-slim
    container_name: stocksync
    restart: unless-stopped
    working_dir: /app
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: "3000"
      DB_PATH: /data/stocksync.db
      SECURE_COOKIE: "1"
      TRUST_PROXY: "1"
      PASSWORD_MIN_LENGTH: \${PASSWORD_MIN_LENGTH:-10}
      ADMIN_USERNAME: \${ADMIN_USERNAME:-jiny}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD:-}
      SRC_URL: ${JSON.stringify(url)}
      DEPLOY_SHA: ${JSON.stringify(sha)}
    volumes:
      - stocksync_app:/app
      - stocksync_data:/data
    command:
      - /bin/sh
      - -ec
      - |
        mkdir -p /app /data
        cd /app
        if [ ! -f .deploy-sha ] || [ "$$(cat .deploy-sha)" != "$$DEPLOY_SHA" ] || [ ! -d node_modules ]; then
          find /app -mindepth 1 -maxdepth 1 -exec rm -rf {} +
          node -e ${JSON.stringify(fetchCode)}
          tar xzf /tmp/s.tgz --strip-components=1 -C /app
          npm ci --omit=dev --no-audit --no-fund
          printf '%s' "$$DEPLOY_SHA" > .deploy-sha
        fi
        exec node --disable-warning=ExperimentalWarning src/server.js
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.stocksync.rule=Host(\`${domain}\`)"
      - "traefik.http.routers.stocksync.entrypoints=websecure"
      - "traefik.http.routers.stocksync.tls=true"
${resolverLabel}      - "traefik.http.services.stocksync.loadbalancer.server.port=3000"
    healthcheck:
      test: ["CMD", "node", "-e", ${JSON.stringify(health)}]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 150s

volumes:
  stocksync_app:
  stocksync_data:
`;
}

// 환경변수 문자열(KEY=VALUE 줄). 값에 줄바꿈이 있으면 거부한다.
export function environmentText(env) {
  const lines = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === '') continue;
    if (/[\r\n]/.test(String(v))) throw new Error(`${k} 값에 줄바꿈이 있습니다.`);
    lines.push(`${k}=${v}`);
  }
  return lines.join('\n');
}

async function api(token, method, path, body) {
  const res = await fetch(API_ROOT + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'curl/8.5.0',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* 본문이 JSON 이 아니면 비워 둔다 */ }
  if (!res.ok) {
    const msg = String(data.message || 'request rejected').replace(/\s+/g, ' ').slice(0, 200);
    const err = new Error(`Hostinger API ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitAction(token, id, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const d = await api(token, 'GET', `/actions/${id}`);
    const state = String(d.state || d.status || 'unknown');
    console.log(`Hostinger action ${id}: ${state}`);
    if (['success', 'completed'].includes(state)) return;
    if (['failed', 'error', 'cancelled', 'canceled'].includes(state)) throw new Error(`Hostinger action ${id} failed`);
    await sleep(5000);
  }
  throw new Error(`Hostinger action ${id} timed out`);
}

async function waitHealthy(token, timeoutMs = 360_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const p = await api(token, 'GET', `/docker/${PROJECT}/containers`);
    const rows = Array.isArray(p) ? p : p.data || p.containers || [];
    if (rows.length) console.log(`container: ${rows.map((r) => `${r.state}/${r.health || '-'}`).join(', ')}`);
    if (rows.length && rows.every((r) => r.state === 'running' && r.health === 'healthy')) return;
    await sleep(10_000);
  }
  throw new Error('컨테이너가 healthy 가 되지 않았습니다. Hostinger 의 Docker 화면에서 로그를 확인하세요.');
}

async function exists(token) {
  // Hostinger 는 아직 없는 프로젝트를 조회하면 404 대신 403 을 돌려주기도 한다. 진짜 권한 문제면 이어지는 생성 요청에서 드러난다.
  try { return await api(token, 'GET', `/docker/${PROJECT}`); } catch (e) {
    if (e.status === 404 || e.status === 403) { console.log(`프로젝트 조회 ${e.status} → 아직 없는 것으로 처리합니다.`); return null; }
    throw e;
  }
}

async function storeProject(token, content, envText) {
  // 문서에 환경변수 형식이 명시돼 있지 않아 문자열을 먼저 보내고, 형식 오류(422)면 객체로 다시 보낸다.
  try {
    return await api(token, 'POST', '/docker', { project_name: PROJECT, content, environment: envText });
  } catch (e) {
    if (e.status !== 422) throw e;
    const obj = Object.fromEntries(envText.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return api(token, 'POST', '/docker', { project_name: PROJECT, content, environment: obj });
  }
}

async function verifyPublic() {
  const url = `https://${DOMAIN}/login`;
  for (let i = 0; i < 24; i += 1) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockSyncDeploy/1.0)' }, signal: AbortSignal.timeout(15_000) });
      if (r.ok && (await r.text()).includes('StockSync')) { console.log(`공개 주소 확인: ${url} OK`); return true; }
    } catch { /* 다시 시도 */ }
    await sleep(5000);
  }
  return false;
}

async function main() {
  const token = process.env.HOSTINGER_API_KEY;
  const sha = process.env.GITHUB_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token) {
    console.log('::notice::HOSTINGER_API_KEY 시크릿이 없어 배포를 건너뜁니다. 저장소 Settings → Secrets and variables → Actions 에 등록하세요.');
    return;
  }
  if (!sha || !repository) throw new Error('GITHUB_SHA, GITHUB_REPOSITORY 가 필요합니다.');

  let resolver = '';
  try {
    const t = await api(token, 'GET', '/docker/traefik');
    resolver = certificateResolver(t.content || t.compose);
  } catch (e) { console.log(`Traefik 정보를 읽지 못했습니다(${e.message}). 기본 resolver 이름을 씁니다.`); }
  console.log(`인증서 resolver: ${resolver || '(자동 감지 실패 → letsencrypt)'}`);

  const current = await exists(token);
  console.log(current ? '기존 stocksync 프로젝트를 갱신합니다.' : 'stocksync 프로젝트를 새로 만듭니다.');
  const adminPassword = process.env.STOCKSYNC_ADMIN_PASSWORD || '';
  const envText = environmentText({
    PASSWORD_MIN_LENGTH: process.env.STOCKSYNC_PASSWORD_MIN_LENGTH || '10',
    ADMIN_USERNAME: process.env.STOCKSYNC_ADMIN_USERNAME || 'jiny',
    // 계정이 한번 만들어지면 이 값은 쓰이지 않는다. 시크릿을 지우면 다음 배포부터 서버 환경에서도 사라진다.
    ADMIN_PASSWORD: adminPassword,
  });

  const content = composeContent({ repository, sha, resolver: resolver || 'letsencrypt' });
  const stored = await storeProject(token, content, envText);
  await waitAction(token, Number(stored.id));
  const updated = await api(token, 'POST', `/docker/${PROJECT}/update`);
  await waitAction(token, Number(updated.id));
  await waitHealthy(token);
  console.log('컨테이너가 정상입니다.');
  if (!(await verifyPublic())) {
    console.log(`::warning::https://${DOMAIN}/login 에 아직 접속되지 않습니다. DNS(Cloudflare A 레코드)와 인증서 발급 상태를 확인하세요. 배포 자체는 완료됐습니다.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(`배포 실패: ${e.message}`); process.exit(1); });
}
