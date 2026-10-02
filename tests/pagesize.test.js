import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceFor, pageSizeFor, PAGE_SIZE } from '../src/lib/pagesize.js';

const req = (cookie, ua) => ({ headers: { ...(cookie ? { cookie } : {}), ...(ua ? { 'user-agent': ua } : {}) } });

test('목록 개수 규칙: 폰 10, PC 20', () => {
  assert.deepEqual(PAGE_SIZE, { mobile: 10, desktop: 20 });
  assert.equal(pageSizeFor(req()), 20);
  assert.equal(pageSizeFor(req('dv=m')), 10);
  assert.equal(pageSizeFor(req('sid=abc; dv=m; x=1')), 10);
  assert.equal(pageSizeFor(req('dv=d')), 20);
});

test('쿠키가 없으면 접속 기기로 추정 (태블릿은 PC 취급)', () => {
  assert.equal(deviceFor(req('', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148')), 'mobile');
  assert.equal(deviceFor(req('', 'Mozilla/5.0 (Linux; Android 14; SM-S918N) Mobile Safari/537.36')), 'mobile');
  assert.equal(deviceFor(req('', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')), 'desktop');
  assert.equal(deviceFor(req('', 'Mozilla/5.0 (Linux; Android 14; SM-X900) Safari/537.36')), 'desktop');
  assert.equal(deviceFor(req('', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130')), 'desktop');
});

test('쿠키 값이 이상하면 무시한다', () => {
  assert.equal(deviceFor(req('dv=x', 'Mobile')), 'mobile');
  assert.equal(deviceFor(req('xdv=m')), 'desktop');
});
