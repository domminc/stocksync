import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

test('CSS/JS 주소에 내용 해시(?v=)가 붙고, 해시가 있을 때만 오래 캐시한다', async () => {
  const server = createApp({ db: openDb(':memory:') }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/login`)).text();
    const v = /style\.css\?v=([0-9a-f]{10})"/.exec(html)?.[1];
    assert.ok(v, '로그인 화면의 CSS 주소에 ?v= 해시');
    assert.match(html, new RegExp(`app\\.js\\?v=${v}"`));
    const withV = await fetch(`${base}/static/style.css?v=${v}`);
    assert.match(withV.headers.get('cache-control'), /immutable/);
    const plain = await fetch(`${base}/static/style.css`);
    assert.equal(plain.headers.get('cache-control'), 'no-cache');
  } finally {
    server.close();
  }
});

test('한글 글꼴(Pretendard 부분 집합)을 사이트에서 직접 내려주고 오래 캐시한다', async () => {
  const server = createApp({ db: openDb(':memory:') }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const css = await (await fetch(`${base}/static/style.css`)).text();
    const url = /url\("(\/static\/fonts\/[^"?]+\.woff2)/.exec(css)?.[1];
    assert.ok(url, 'style.css 에 글꼴 주소');
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /immutable/);
    assert.ok((await res.arrayBuffer()).byteLength > 100000);
  } finally {
    server.close();
  }
});
