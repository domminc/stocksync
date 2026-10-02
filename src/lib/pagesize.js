/**
 * 목록 한 페이지에 보여 줄 개수: 폰(화면 폭 640px 이하) 10개, 그 밖(PC·태블릿) 20개.
 * 서버는 화면 폭을 모르므로 ① 브라우저가 알려 준 쿠키 dv(m=폰, d=PC) → ② 없으면 접속 기기(User-Agent)로 추정한다.
 * 쿠키는 public/app.js 가 실제 화면 폭을 보고 설정한다.
 */
export const PAGE_SIZE = { mobile: 10, desktop: 20 };
export const MOBILE_MAX_WIDTH = 640;

export function deviceFor(req) {
  const m = /(?:^|;\s*)dv=([md])(?:;|$)/.exec(req.headers.cookie || '');
  if (m) return m[1] === 'm' ? 'mobile' : 'desktop';
  const ua = String(req.headers['user-agent'] || '');
  return /Mobi|iPhone|iPod|Android.*Mobile/i.test(ua) ? 'mobile' : 'desktop';
}

export const pageSizeFor = (req) => PAGE_SIZE[deviceFor(req)];
