import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createAgent, isAllowedHost, isSafePrinterName } from '../public/print-agent/agent.mjs';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const OK = 'https://jejubaseball.com';

test('허용 IP: 루프백·사설망만, 인터넷 주소와 잘못된 값은 거부', () => {
  for (const ok of ['127.0.0.1', '10.1.2.3', '192.168.0.50', '172.16.0.1', '172.31.255.255']) assert.ok(isAllowedHost(ok), ok);
  for (const bad of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '999.1.1.1', 'example.com', '', '1.2.3']) assert.ok(!isAllowedHost(bad), bad);
  assert.ok(isSafePrinterName('Xprinter XP-DT427B') && isSafePrinterName('라벨 프린터'));
  for (const bad of ['', 'a"b', 'a;b', 'a|b', '$(x)', 'a`b', 'a\nb', 'x'.repeat(121)]) assert.ok(!isSafePrinterName(bad), JSON.stringify(bad));
});

test('중계 프로그램: 상태·CORS(허용 사이트만)·네트워크 프린터로 그대로 전달', async () => {
  const received = [];
  const printer = net.createServer((sock) => { const c = []; sock.on('data', (d) => c.push(d)); sock.on('end', () => received.push(Buffer.concat(c))); });
  const printerPort = await listen(printer);
  const agent = createAgent({ origins: [OK] });
  const port = await listen(agent);
  const base = `http://127.0.0.1:${port}`;
  try {
    const st = await fetch(`${base}/status`, { headers: { origin: OK } });
    assert.equal(st.status, 200);
    assert.equal(st.headers.get('access-control-allow-origin'), OK);
    assert.equal(st.headers.get('access-control-allow-private-network'), 'true');
    assert.equal((await st.json()).name, 'stocksync-print-agent');
    // 사전 요청(preflight)
    const pre = await fetch(`${base}/print`, { method: 'OPTIONS', headers: { origin: OK, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /content-type/);
    // 다른 사이트는 거부
    assert.equal((await fetch(`${base}/status`, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/print?host=127.0.0.1&port=${printerPort}`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: 'x' })).status, 403);
    // 라벨 명령(이진 데이터 포함)이 한 바이트도 바뀌지 않고 도착한다
    const payload = Buffer.concat([Buffer.from('SIZE 50 mm,30 mm\r\nBITMAP 0,0,1,1,0,'), Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80]), Buffer.from('\r\nPRINT 1,1\r\n')]);
    const r = await fetch(`${base}/print?host=127.0.0.1&port=${printerPort}`, { method: 'POST', headers: { origin: OK, 'content-type': 'application/octet-stream' }, body: payload });
    assert.deepEqual(await r.json(), { ok: true, bytes: payload.length });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(received.length, 1);
    assert.ok(received[0].equals(payload));
    // 잘못된 요청
    assert.equal((await fetch(`${base}/print?host=8.8.8.8`, { method: 'POST', body: 'x' })).status, 400, '인터넷 주소는 거부');
    assert.equal((await fetch(`${base}/print?host=127.0.0.1&port=${printerPort}`, { method: 'POST' })).status, 400, '빈 내용');
    assert.equal((await fetch(`${base}/print?printer=${encodeURIComponent('a"; calc')}`, { method: 'POST', body: 'x' })).status, 400, '이상한 프린터 이름');
    assert.equal((await fetch(`${base}/print`, { method: 'POST', body: 'x' })).status, 400, '프린터 미지정');
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    // 프린터가 꺼져 있으면(포트가 닫혀 있으면) 오류를 알려 준다
    const closed = net.createServer();
    const closedPort = await listen(closed);
    await new Promise((res) => closed.close(res));
    const down = await fetch(`${base}/print?host=127.0.0.1&port=${closedPort}`, { method: 'POST', body: 'x' });
    assert.equal(down.status, 500);
    assert.match((await down.json()).error, /연결하지 못했습니다/);
  } finally {
    agent.close(); printer.close();
  }
});

test('중계 프로그램: 주소창으로 열면 실행 중 안내가 보이고(CORS 불필요), 허용 사이트에 www 도 포함', async () => {
  const { DEFAULT_ORIGINS, VERSION } = await import('../public/print-agent/agent.mjs');
  assert.ok(DEFAULT_ORIGINS.includes('https://jejubaseball.com') && DEFAULT_ORIGINS.includes('https://www.jejubaseball.com'));
  const agent = createAgent();
  const port = await listen(agent);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /실행 중입니다/);
    assert.ok(html.includes(VERSION) && html.includes('https://jejubaseball.com'));
    const ok = await fetch(`http://127.0.0.1:${port}/status`, { headers: { origin: 'https://www.jejubaseball.com' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://www.jejubaseball.com');
  } finally { agent.close(); }
});
