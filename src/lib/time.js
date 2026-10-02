const kst = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

export const nowIso = () => new Date().toISOString();

/** ISO 시각을 한국 시간 "2026. 10. 02. 14:05" 형태로 표시 */
export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : kst.format(d);
}
