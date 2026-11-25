// tools/shots.mjs — 실행 중인 JobMate 화면을 단계별로 캡처해 docs/images/ui-*.png 로 저장합니다.
// 사용법: (서버 실행 중) node tools/shots.mjs [서버주소=http://127.0.0.1:5400]
// 원리: Edge를 "headless"(화면 없이)로 띄우고 CDP(Chrome DevTools Protocol, WebSocket)로 클릭·입력·캡처를 지시합니다.
//       외부 라이브러리(puppeteer 등) 없이 Node 24 내장 WebSocket/fetch만 사용합니다.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5400';
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
if (!EDGE) throw new Error('Edge 또는 Chrome을 찾을 수 없습니다.');

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'images');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'jm-shot-'));
const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--window-size=1180,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pending = new Map();
try {
  let target;
  for (let i = 0; i < 40 && !target; i++) { await sleep(300); try { target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find((t) => t.type === 'page'); } catch { /* 아직 부팅 중 */ } }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const shot = async (name) => {
    const m = (await send('Page.getLayoutMetrics')).result.cssContentSize;
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1180, height: Math.ceil(m.height), scale: 1 } });
    writeFileSync(join(out, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name);
  };
  await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  await sleep(1500);
  await js("document.getElementById('sample').click()"); await sleep(600);
  await shot('ui-1-input.png');
  await js("document.getElementById('go').click()"); await sleep(1500);
  await shot('ui-2-recommend.png');
  await js("document.getElementById('rev').click()"); await sleep(1500);
  await js("document.getElementById('p3').scrollIntoView()");
  await shot('ui-3-review.png');
  await js("document.getElementById('fix').click()");
  for (let i = 0; i < 90; i++) { await sleep(2000); if (!(await js("document.getElementById('fix').disabled"))) break; } // AI(Ollama)가 느릴 수 있어 최대 3분 대기
  await shot('ui-4-revise.png');

  // 발표자료·보고서용 "잘린 데 없는" 부분 캡처: 목록의 N번째 항목 끝에서 정확히 자릅니다(임의 높이로 자르면 항목이 반쯤 잘려 보임).
  const clipShot = async (name, topSel, itemSel, n) => {
    const rect = await js(`(() => { const top = document.querySelector('${topSel}').getBoundingClientRect(); const items = [...document.querySelectorAll('${itemSel}')]; const last = items[Math.min(${n}, items.length) - 1].getBoundingClientRect(); const y = top.top + scrollY; return { x: Math.floor(top.left), y: Math.floor(y), w: Math.ceil(top.width), h: Math.ceil(last.bottom + scrollY - y + 10) }; })()`);
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } });
    writeFileSync(join(out, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name, rect.w + 'x' + rect.h);
  };
  await clipShot('crop-review.png', '#p3', '#items .item', 3);
  await clipShot('crop-revise.png', '#p4', '#sugs .sug', 3);
  await clipShot('crop-recommend.png', '#p2', '#p2 .hint', 1);
} finally { try { ws?.close(); } catch { /* 이미 닫힘 */ } proc.kill(); }
