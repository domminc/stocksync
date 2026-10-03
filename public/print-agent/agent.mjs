// StockSync 라벨 출력 중계 프로그램 — 매장 PC 에서 실행한다 (Node.js 18 이상, 외부 패키지 없음).
//   node agent.mjs
// 웹사이트가 만든 프린터 명령(TSPL)을 받아 프린터로 그대로 전달한다.
//   - 윈도우: 설치된 프린터 이름으로 RAW 전송 (USB 프린터 포함, 드라이버 설치 필요)
//   - 네트워크: 프린터 IP 의 9100 포트로 전송
// 이 PC 안(127.0.0.1)에서만 열리고, 허용한 사이트(기본 https://jejubaseball.com)의 요청만 받는다.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VERSION = '1.1.0';
export const DEFAULT_ORIGINS = ['https://jejubaseball.com', 'https://www.jejubaseball.com'];
const MAX_BODY = 32 * 1024 * 1024;

const PS_RAW = `param([string]$Printer,[string]$Path)
$src = @"
using System;
using System.Runtime.InteropServices;
public class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("프린터를 열 수 없습니다 (이름 확인): " + printer + " / 오류 " + Marshal.GetLastWin32Error());
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "StockSync labels"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) throw new Exception("인쇄 작업을 시작하지 못했습니다: " + Marshal.GetLastWin32Error());
      StartPagePrinter(h);
      int written;
      if (!WritePrinter(h, bytes, bytes.Length, out written)) throw new Exception("프린터로 보내지 못했습니다: " + Marshal.GetLastWin32Error());
      EndPagePrinter(h); EndDocPrinter(h);
    } finally { ClosePrinter(h); }
  }
}
"@
Add-Type -TypeDefinition $src
[RawPrint]::Send($Printer, [System.IO.File]::ReadAllBytes($Path))
`;

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

/** 허용한 IP 만: 이 PC(루프백)와 사내망(사설 IPv4). 인터넷 주소로 보내는 용도로 악용되지 않게 한다. */
export function isAllowedHost(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host));
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export const isSafePrinterName = (n) => typeof n === 'string' && n.length > 0 && n.length <= 120 && !/[\u0000-\u001f"`$;|&<>]/.test(n);

function sendToNetwork(host, port, bytes) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port }, () => { sock.end(bytes); });
    sock.setTimeout(15000, () => { sock.destroy(); reject(new Error('프린터 응답 시간 초과 (IP·전원·네트워크 확인)')); });
    sock.on('error', (e) => reject(new Error(`프린터에 연결하지 못했습니다: ${e.message}`)));
    sock.on('close', (hadError) => { if (!hadError) resolve(); });
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').toString().trim().slice(0, 300) || '명령 실행 실패'));
      else resolve(stdout.toString());
    });
  });
}

async function sendToSystemPrinter(name, bytes, tmpDir) {
  const file = path.join(tmpDir, `job-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  fs.writeFileSync(file, bytes);
  try {
    if (process.platform === 'win32') {
      const ps = path.join(tmpDir, 'rawprint.ps1');
      fs.writeFileSync(ps, `﻿${PS_RAW}`, 'utf8'); // BOM: 윈도우 PowerShell 이 한글을 올바르게 읽도록
      await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Printer', name, '-Path', file]);
    } else {
      await run('lp', ['-d', name, '-o', 'raw', file]); // macOS·리눅스(개발·시험용)
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function listPrinters() {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress']);
    const v = JSON.parse(out.trim() || '[]');
    return Array.isArray(v) ? v : [v];
  }
  const out = await run('lpstat', ['-e']).catch(() => '');
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** 출력 중계 서버 만들기 (테스트에서도 쓴다) */
export function createAgent({ origins = DEFAULT_ORIGINS, tmpDir = os.tmpdir() } = {}) {
  const allowed = new Set(origins);
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) return json(res, 403, { ok: false, error: '허용되지 않은 사이트입니다.' });
    const cors = origin ? {
      'access-control-allow-origin': origin, vary: 'Origin',
      'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type',
      'access-control-allow-private-network': 'true', 'access-control-max-age': '600',
    } : {};
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      // 이 PC 의 브라우저 주소창에 http://127.0.0.1:9101 을 입력해 프로그램이 실행 중인지 바로 확인할 수 있다
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>StockSync 출력 프로그램</title><body style="font:16px sans-serif;padding:24px"><h2>StockSync 출력 프로그램이 실행 중입니다 ✅</h2><p>버전 ${VERSION} · 허용 사이트: ${[...allowed].join(', ')}</p><p>이 창은 닫아도 됩니다. 사이트의 라벨 화면에서 “프린터로 출력”을 누르세요.</p></body>`);
      }
      if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, { ok: true, name: 'stocksync-print-agent', version: VERSION, platform: process.platform }, cors);
      if (req.method === 'GET' && url.pathname === '/printers') return json(res, 200, { ok: true, printers: await listPrinters() }, cors);
      if (req.method === 'POST' && url.pathname === '/print') {
        const chunks = [];
        let size = 0;
        for await (const c of req) { size += c.length; if (size > MAX_BODY) return json(res, 413, { ok: false, error: '한 번에 보내는 양이 너무 큽니다.' }, cors); chunks.push(c); }
        const bytes = Buffer.concat(chunks);
        if (!bytes.length) return json(res, 400, { ok: false, error: '보낼 내용이 없습니다.' }, cors);
        const host = url.searchParams.get('host');
        if (host) {
          const port = Number(url.searchParams.get('port') || 9100);
          if (!isAllowedHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, { ok: false, error: '프린터 IP 가 올바르지 않습니다 (사내망 주소만 가능).' }, cors);
          await sendToNetwork(host, port, bytes);
        } else {
          const name = url.searchParams.get('printer');
          if (!isSafePrinterName(name)) return json(res, 400, { ok: false, error: '프린터 이름이 올바르지 않습니다.' }, cors);
          await sendToSystemPrinter(name, bytes, tmpDir);
        }
        return json(res, 200, { ok: true, bytes: bytes.length }, cors);
      }
      return json(res, 404, { ok: false, error: '없는 주소입니다.' }, cors);
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e).slice(0, 300) }, cors);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.AGENT_PORT || 9101);
  const origins = (process.env.AGENT_ORIGINS || DEFAULT_ORIGINS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  createAgent({ origins }).listen(port, '127.0.0.1', () => {
    console.log(`StockSync 출력 프로그램 ${VERSION} 실행 중: http://127.0.0.1:${port}`);
    console.log(`허용 사이트: ${origins.join(', ')}`);
    console.log('이 창을 닫으면 프린터 출력이 멈춥니다. (자동 실행 설치를 했다면 창 없이 백그라운드로 실행됩니다)');
  }).on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `포트 ${port} 를 이미 사용 중입니다. 프로그램이 이미 실행 중일 수 있습니다.` : e.message); process.exit(1); });
}
