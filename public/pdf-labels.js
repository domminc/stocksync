// 라벨 PDF 만들기 (외부 라이브러리 없음). 브라우저에서 만들어 내려받고, Node 테스트에서도 같은 코드를 쓴다.
//  - 페이지 크기 = 라벨 크기(예: 50×30mm), 라벨 1장 = 1페이지. 프린터 드라이버에서 같은 용지 크기를 고르고 "실제 크기(100%)"로 인쇄한다.
//  - 가격·상품명은 이미지 마스크(1비트, 검정만 찍힘), 바코드는 벡터 막대(선 굵기를 프린터 점에 맞춤), 아래 숫자는 기본 글꼴(Helvetica).
const PT_PER_MM = 72 / 25.4;
const pt = (mm) => (mm * PT_PER_MM).toFixed(3).replace(/\.?0+$/, '');
const enc = new TextEncoder();

const HELV_WIDTH = (ch) => (/[0-9]/.test(ch) ? 0.556 : /[A-Z]/.test(ch) ? 0.68 : ch === '-' ? 0.333 : 0.56);
const textWidthPt = (s, size) => [...s].reduce((n, ch) => n + HELV_WIDTH(ch), 0) * size;
const escPdf = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([()\\])/g, '\\$1');

/** '1'(검정)/'0' 패턴 → 연속 막대 구간 [{start, len}] */
export function barRuns(bits) {
  const runs = [];
  for (let i = 0; i < bits.length;) {
    if (bits[i] !== '1') { i++; continue; }
    let j = i;
    while (j < bits.length && bits[j] === '1') j++;
    runs.push({ start: i, len: j - i });
    i = j;
  }
  return runs;
}

/**
 * labels: [{
 *   image: { widthPx, heightPx, data: Uint8Array(1비트, 0=검정), xMm, yMm, wMm, hMm } | null,   // 라벨 위쪽 기준 mm
 *   barcode: { bits: '1010…', moduleMm, xMm, yMm, hMm } | null,
 *   human: { text, yMm, sizePt } | null,       // 바코드 아래 숫자 (yMm: 글자 위쪽)
 *   copies: 1
 * }]
 * 반환: Uint8Array (PDF 파일)
 */
export function buildLabelsPdf({ widthMm, heightMm, labels }) {
  const objs = []; // 각 항목: Uint8Array (본문)
  const add = (parts) => { objs.push(parts); return objs.length; }; // 번호 = 순서(1부터)
  const catalog = add(null); // 1 (나중에 채움)
  const pages = add(null); // 2
  const font = add(enc.encode('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  const W = widthMm * PT_PER_MM;
  const H = heightMm * PT_PER_MM;
  const pageIds = [];

  const stream = (dict, bytes) => concat([enc.encode(`<< ${dict} /Length ${bytes.length} >>\nstream\n`), bytes, enc.encode('\nendstream')]);

  for (const lab of labels) {
    let imageId = 0;
    let content = '';
    if (lab.image) {
      const im = lab.image;
      imageId = add(stream(`/Type /XObject /Subtype /Image /Width ${im.widthPx} /Height ${im.heightPx} /ImageMask true /BitsPerComponent 1 /Interpolate false`, im.data));
      const y = H - (im.yMm + im.hMm) * PT_PER_MM;
      content += `q ${pt(im.wMm)} 0 0 ${pt(im.hMm)} ${pt(im.xMm)} ${y.toFixed(3)} cm /Im1 Do Q\n`;
    }
    content += '0 g\n';
    if (lab.barcode) {
      const b = lab.barcode;
      const y = H - (b.yMm + b.hMm) * PT_PER_MM;
      for (const r of barRuns(b.bits)) content += `${pt(b.xMm + r.start * b.moduleMm)} ${y.toFixed(3)} ${pt(r.len * b.moduleMm)} ${pt(b.hMm)} re\n`;
      content += 'f\n';
    }
    if (lab.human) {
      const h = lab.human;
      const w = textWidthPt(h.text, h.sizePt);
      const baseline = H - h.yMm * PT_PER_MM - h.sizePt * 0.8;
      content += `BT /F1 ${h.sizePt} Tf ${((W - w) / 2).toFixed(3)} ${baseline.toFixed(3)} Td (${escPdf(h.text)}) Tj ET\n`;
    }
    const contentId = add(stream('', enc.encode(content)));
    const res = `<< /Font << /F1 ${font} 0 R >>${imageId ? ` /XObject << /Im1 ${imageId} 0 R >>` : ''} >>`;
    const copies = Math.max(1, Math.min(Number(lab.copies) || 1, 999));
    for (let c = 0; c < copies; c++) {
      pageIds.push(add(enc.encode(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${W.toFixed(3)} ${H.toFixed(3)}] /Resources ${res} /Contents ${contentId} 0 R >>`)));
    }
  }
  if (!pageIds.length) throw new Error('출력할 라벨이 없습니다.');
  objs[catalog - 1] = enc.encode(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  objs[pages - 1] = enc.encode(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);

  // 파일 조립 (객체 위치표 포함)
  const chunks = [enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  const offsets = [];
  let pos = chunks[0].length;
  objs.forEach((body, i) => {
    offsets.push(pos);
    const head = enc.encode(`${i + 1} 0 obj\n`);
    const tail = enc.encode('\nendobj\n');
    chunks.push(head, body, tail);
    pos += head.length + body.length + tail.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`];
  for (const o of offsets) xref.push(`${String(o).padStart(10, '0')} 00000 n \n`);
  xref.push(`trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`);
  chunks.push(enc.encode(xref.join('')));
  return concat(chunks);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
