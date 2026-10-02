import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeContent, environmentText, certificateResolver } from '../scripts/deploy-hostinger.mjs';

const sha = 'a'.repeat(40);

test('배포 compose: 도메인·Traefik 라벨·고정 커밋을 담고 비밀값은 담지 않는다', () => {
  const c = composeContent({ repository: 'domminc/stocksync', sha, resolver: 'le' });
  assert.match(c, /Host\(`jejubaseball\.com`\)/);
  assert.match(c, /certresolver=le/);
  assert.match(c, new RegExp(`tar\\.gz/${sha}`));
  assert.match(c, /\$\{ADMIN_PASSWORD:-\}/); // 값이 아니라 치환 자리만
  assert.match(c, /cap_drop/);
  assert.match(c, /\$\$DEPLOY_SHA/); // compose 가 먼저 치환하지 않도록 이스케이프
});

test('환경변수 문자열: 빈 값은 빼고, 줄바꿈은 거부한다', () => {
  assert.equal(environmentText({ A: '1', B: '', C: undefined, D: 'x' }), 'A=1\nD=x');
  assert.throws(() => environmentText({ A: 'a\nB=c' }));
});

test('Traefik compose 에서 인증서 resolver 이름을 찾는다', () => {
  assert.equal(certificateResolver('- --certificatesresolvers.letsencrypt.acme.email=a'), 'letsencrypt');
  assert.equal(certificateResolver('nothing'), '');
});
