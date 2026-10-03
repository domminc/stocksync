// TSPL(라벨 프린터 명령어) 만들기. 브라우저와 Node 테스트에서 같이 쓰는 순수 함수 모음이다.
//  - 203dpi 프린터는 1mm = 8점(dot)
//  - 한글 상품명은 프린터에 한글 글꼴이 없어도 되도록 "이미지(BITMAP)"로 보내고, 바코드는 프린터 내장 기능(BARCODE)으로 그린다.
export const DOTS_PER_MM = 8;
export const SIZES = { '50x30': { w: 50, h: 30 }, '40x25': { w: 40, h: 25 } };
export const mmToDots = (mm) => Math.round(mm * DOTS_PER_MM);

const enc = new TextEncoder();

export function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * RGBA 픽셀 → 1비트 비트맵. 글자(어두운 곳)만 프린터가 찍도록 바꾼다.
 * TSPL 비트맵은 기본적으로 비트 0 = 검정(인쇄), 1 = 흰색이다. 프린터에서 반전되어 나오면 blackBit 을 1 로 쓴다.
 */
export function monoBitmap(rgba, width, height, { threshold = 160, blackBit = 0 } = {}) {
  const widthBytes = Math.ceil(width / 8);
  const data = new Uint8Array(widthBytes * height);
  if (blackBit === 0) data.fill(0xff);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3] / 255;
      const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      const v = luma * a + 255 * (1 - a); // 흰 바탕 위에 합성
      if (v < threshold) {
        const at = y * widthBytes + (x >> 3);
        const mask = 0x80 >> (x & 7);
        if (blackBit === 0) data[at] &= ~mask; else data[at] |= mask;
      }
    }
  }
  return { widthBytes, height, data };
}

const header = ({ widthMm, heightMm, gapMm = 2, media = 'gap', density = 8, speed = 4, reverse = false }) => {
  const lines = [`SIZE ${widthMm} mm,${heightMm} mm`];
  if (media === 'bline') lines.push(`BLINE ${gapMm} mm,0 mm`);
  else if (media === 'continuous') lines.push('GAP 0 mm,0 mm');
  else lines.push(`GAP ${gapMm} mm,0 mm`);
  lines.push(`DIRECTION ${reverse ? 0 : 1},0`, 'REFERENCE 0,0', `DENSITY ${density}`, `SPEED ${speed}`, 'CLS');
  return lines;
};

/**
 * 라벨 안의 배치 계산 (점 단위). 가격 → (선택) 상품명 → 바코드 순서로 위에서 아래로 쌓고,
 * 바코드 아래 사람이 읽는 숫자(약 28점)까지 라벨 안에 들어오도록 바코드 높이를 맞춘다.
 */
export function labelLayout(widthMm, heightMm, { showName = false, showPrice = true } = {}) {
  const W = mmToDots(widthMm);
  const H = mmToDots(heightMm);
  const small = H < 220; // 40×25mm 처럼 작은 라벨
  const nameFont = small ? 20 : 24;
  const priceFont = small ? 34 : 44;
  const nameH = showName ? Math.round(nameFont * 2.3) : 0; // 두 줄
  const priceH = showPrice ? Math.round(priceFont * 1.25) : 0;
  const textH = nameH + priceH;
  const textW = Math.floor((W - 16) / 8) * 8;
  const HUMAN = 28;
  let barcodeY = textH ? 6 + textH + 4 : 8;
  let barcodeH = Math.max(30, Math.min(110, H - barcodeY - HUMAN - 4));
  if (!textH) barcodeY = Math.max(8, Math.round((H - barcodeH - HUMAN) / 2)); // 바코드만이면 세로 가운데
  return { W, H, textX: Math.round((W - textW) / 2), textY: 6, textW, textH, nameFont, priceFont, nameH, priceH, barcodeY, barcodeH };
}

/** Code 128 의 총 칸 수 (src/lib/barcodes.js 의 code128Bits 길이와 같아야 한다 — 테스트로 확인) */
export function code128Modules(value) {
  const s = String(value);
  const digits = /^\d+$/.test(s) && s.length >= 4;
  const symbols = digits ? (s.length % 2 ? 3 + (s.length - 1) / 2 : 1 + s.length / 2) + 1 : 1 + s.length + 1;
  return symbols * 11 + 13;
}

const clampInt = (v, lo, hi, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };

/** 라벨 1종 × 장수(copies) 를 인쇄하는 명령어 묶음 */
export function buildLabelJob(opts) {
  const o = { ...opts };
  o.density = clampInt(o.density, 0, 15, 8);
  o.speed = clampInt(o.speed, 1, 8, 4);
  const copies = clampInt(o.copies, 1, 999, 1);
  const parts = [enc.encode(`${header(o).join('\r\n')}\r\n`)];
  const t = o.textBitmap;
  if (t) {
    parts.push(enc.encode(`BITMAP ${t.x},${t.y},${t.widthBytes},${t.height},0,`), t.data, enc.encode('\r\n'));
  }
  const b = o.barcode;
  if (b && b.value) {
    const value = String(b.value).replace(/["\r\n]/g, '');
    const narrow = clampInt(b.narrow, 1, 6, 3);
    const height = clampInt(b.height, 20, 200, 80);
    const human = b.human === false ? 0 : 1;
    if (b.kind === 'ean13' && /^\d{13}$/.test(value)) {
      // EAN-13: 12자리만 보내면 프린터가 체크디지트를 계산한다 (우리 번호는 항상 올바른 13자리)
      const widthDots = 95 * narrow;
      const x = b.x ?? Math.max(0, Math.round((mmToDots(o.widthMm) - widthDots) / 2));
      parts.push(enc.encode(`BARCODE ${x},${b.y},"EAN13",${height},${human},0,${narrow},${narrow * 2},"${value.slice(0, 12)}"\r\n`));
    } else {
      // Code 128 (프린터가 A/B/C 코드셋을 자동 선택). 가는 선 2점(0.25mm) 이하로 두어 라벨 폭 안에 들어가게 한다.
      const n128 = Math.min(narrow, 2);
      const x = b.x ?? Math.max(0, Math.round((mmToDots(o.widthMm) - code128Modules(value) * n128) / 2));
      parts.push(enc.encode(`BARCODE ${x},${b.y},"128",${height},${human},0,${n128},${n128 * 2},"${value}"\r\n`));
    }
  }
  parts.push(enc.encode(`PRINT 1,${copies}\r\n`));
  return concatBytes(parts);
}

/** 용지(갭/블랙마크) 자동 감지 명령. 처음 한 번, 또는 라벨 종류를 바꿨을 때 쓴다. */
export function buildCalibrate(opts) {
  const o = { ...opts };
  const lines = header(o).filter((l) => l !== 'CLS');
  lines.push(o.media === 'bline' ? 'BLINE' : 'GAPDETECT');
  return enc.encode(`${lines.join('\r\n')}\r\n`);
}
