// ─────────────────────────────────────────────────────────────────────────────
// http.mjs — HTTP API와 정적 파일 서빙 (Express 같은 프레임워크 없이 Node 기본 http만 사용)
//
// [엔드포인트 요약]
//   GET  /api/status            서버·LLM·검색 모드 상태
//   GET  /api/jobs              직무 목록(이름·요약·핵심 역량)
//   GET  /api/jobs/guide?id=    직무별 작성 가이드(지식 청크)
//   GET  /api/kb/search?q=      지식베이스 검색(근거 확인용)
//   GET  /api/sample            시연용 샘플 이력서·자소서
//   POST /api/analyze           ①문서 제출 → 직무 추천
//   POST /api/review            ②선택 직무 기준 점검
//   POST /api/revise            ③문장 보완 제안
//   POST /api/posting           ★채용 공고 요건 대조 점검
//   POST /api/feedback          추천·점검·제안이 도움이 됐는지 평가
//   GET  /api/history?userId=   내 기록(점검 점수 변화)
//   GET  /api/stats             운영 지표
//
// [보안 장치 — 면접에서 설명할 수 있어야 하는 부분]
//   1) 본문 크기 제한(413)        2) userId 형식 검사(SQL은 어차피 바인딩 사용, 이중 방어)
//   3) 사용자당 호출 간격 제한(남용·외부 LLM 비용 보호)   4) 정적 파일 경로 이탈(../) 차단
//   5) 보안 헤더(CSP 등)          6) 내부 오류 메시지를 화면에 노출하지 않음(500은 일반 문구)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { ROOT } from './app.mjs';
import { HttpError } from './errors.mjs';
import { jobById } from './kb.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

// 모든 응답에 붙는 보안 헤더. CSP: 우리 서버의 스크립트·스타일만 실행 허용 → XSS 피해 최소화.
const SECURITY = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY });
  res.end(JSON.stringify(body));
};

// 요청 본문 읽기. 한도를 넘으면 끝까지 읽고 버린 뒤 413(바로 연결을 끊으면 브라우저가 오류를 못 받음).
const readBody = (req, limit) => new Promise((resolve, reject) => {
  let size = 0, tooBig = false; const parts = [];
  req.on('data', (c) => { size += c.length; if (size > limit) tooBig = true; else if (!tooBig) parts.push(c); });
  req.on('end', () => {
    if (tooBig) return reject(new HttpError(413, '요청이 너무 큽니다.'));
    try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'JSON 형식이 올바르지 않습니다.')); }
  });
});

const USER_ID = /^[\w-]{6,64}$/u;
const userOf = (v) => { const id = String(v ?? ''); if (!USER_ID.test(id)) throw new HttpError(400, 'userId가 필요합니다.'); return id; };
const intOf = (v, name) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${name} 값이 올바르지 않습니다.`); return n; };

export function createHandler(svc, { sampleFile = join(ROOT, 'samples', 'demo.json'), minGapMs = 700 } = {}) {
  const lastCall = new Map(); // userId → 마지막 무거운 호출 시각

  // 같은 사용자가 너무 자주 호출하면 429. (분석·점검·보완은 CPU와 외부 LLM 비용을 쓰는 "무거운" 호출)
  const throttle = (userId) => {
    const t = Date.now(), prev = lastCall.get(userId) ?? 0;
    if (t - prev < minGapMs) throw new HttpError(429, '요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.');
    lastCall.set(userId, t);
    if (lastCall.size > 5000) lastCall.clear(); // 메모리 무한 증가 방지
  };

  async function api(req, res, url) {
    const m = req.method, p = url.pathname;
    if (m === 'GET' && p === '/api/status') {
      return json(res, 200, { chunks: svc.chunks.length, jobs: svc.jobs.length, retrieval: svc.retriever.mode, llm: svc.llm.label, llmProvider: svc.llm.available ? svc.llm.provider : null, llmError: svc.llm.lastError });
    }
    if (m === 'GET' && p === '/api/jobs') {
      return json(res, 200, svc.jobs.map((j) => ({ id: j.id, name: j.name, summary: j.summary, core: j.core.map((c) => c.name), nice: j.nice.map((c) => c.name) })));
    }
    if (m === 'GET' && p === '/api/jobs/guide') {
      const job = jobById(String(url.searchParams.get('id') ?? ''));
      if (!job) throw new HttpError(404, '직무를 찾을 수 없습니다.');
      return json(res, 200, { id: job.id, name: job.name, example: job.example, guides: svc.chunks.filter((c) => c.jobId === job.id).map(({ id, title, text }) => ({ id, title, text })) });
    }
    if (m === 'GET' && p === '/api/kb/search') {
      const q = String(url.searchParams.get('q') ?? '').slice(0, 300);
      const hits = await svc.retriever.search(q, 5);
      return json(res, 200, hits.map((h) => ({ id: h.chunk.id, title: h.chunk.title, score: Math.round(h.fused * 100) / 100 })));
    }
    if (m === 'GET' && p === '/api/sample') {
      return json(res, 200, existsSync(sampleFile) ? JSON.parse(readFileSync(sampleFile, 'utf8')) : {});
    }
    if (m === 'GET' && p === '/api/stats') return json(res, 200, svc.store.stats());
    if (m === 'GET' && p === '/api/history') return json(res, 200, svc.store.history(userOf(url.searchParams.get('userId'))));

    if (m === 'POST' && p === '/api/analyze') {
      const b = await readBody(req, 60000);
      const userId = userOf(b.userId); throttle(userId);
      return json(res, 200, await svc.analyze(userId, b.resume, b.cover));
    }
    if (m === 'POST' && p === '/api/review') {
      const b = await readBody(req, 2000);
      const userId = userOf(b.userId); throttle(userId);
      return json(res, 200, await svc.review(userId, intOf(b.submissionId, 'submissionId'), String(b.jobId ?? '')));
    }
    if (m === 'POST' && p === '/api/revise') {
      const b = await readBody(req, 2000);
      const userId = userOf(b.userId); throttle(userId);
      return json(res, 200, await svc.revise(userId, intOf(b.reviewId, 'reviewId'), b.useLlm !== false));
    }
    if (m === 'POST' && p === '/api/posting') {
      const b = await readBody(req, 30000);
      const userId = userOf(b.userId); throttle(userId);
      return json(res, 200, await svc.posting(userId, intOf(b.submissionId, 'submissionId'), b.posting));
    }
    if (m === 'POST' && p === '/api/feedback') {
      const b = await readBody(req, 1000);
      const type = ['recommendation', 'review', 'revision'].includes(b.type) ? b.type : null;
      if (!type) throw new HttpError(400, 'type이 올바르지 않습니다.');
      svc.store.saveFeedback(userOf(b.userId), type, intOf(b.targetId, 'targetId'), !!b.helpful);
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, '찾을 수 없는 API입니다.');
  }

  // 정적 파일(public/): 경로 이탈을 막기 위해 정규화 후 public 폴더 안인지 확인합니다.
  function serveStatic(req, res, url) {
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^[/\\]+/u, '');
    const root = join(ROOT, 'public');
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY }); return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY });
    res.end(readFileSync(file));
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '허용되지 않는 요청입니다.');
      return serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error('[error]', e); // 자세한 원인은 서버 로그에만 남기고,
      return json(res, 500, { error: '서버 내부 오류가 발생했습니다.' }); // 사용자에게는 일반 문구만 보여 줍니다.
    }
  };
}
