// ─────────────────────────────────────────────────────────────────────────────
// jobmate.test.mjs — 자동 테스트 (실행: npm test  또는  node --test test/)
//
// [테스트 원칙]
//   - 외부 LLM을 실제로 부르지 않습니다. 가짜 fetch/가짜 LLM을 끼워 넣어 "어떤 응답이 와도 시스템이 안전한가"를 검증합니다.
//   - 단위 테스트(순수 함수) → 서비스 흐름 → HTTP API 순으로 층을 나눕니다.
//   - 각 테스트 이름이 곧 "요구사항 검증 내용"이 되도록 한국어 문장으로 씁니다(요구사항명세서 ID와 대응).
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, before, after } from 'node:test';
import { createApp } from '../src/app.mjs';
import { createHandler } from '../src/http.mjs';
import { LLM } from '../src/llm.mjs';
import { analyzeDocs, findSkills, hasAlias, isQuantified } from '../src/profile.mjs';
import { recommendJobs } from '../src/recommend.mjs';
import { pickTargets, ruleRewrite, validateRewrite } from '../src/revise.mjs';
import { maskPII, tokens } from '../src/text.mjs';
import { ALL_SKILLS, JOBS } from '../knowledge/jobs.mjs';

const BACKEND_RESUME = '컴퓨터공학 졸업. Spring Boot와 MySQL로 주문 API 12개를 설계·구현했고 응답 시간을 1.2초에서 0.3초로 줄였습니다. 기술: Java, Spring, SQL, Git, Docker. 자격: 정보처리기사. 프로젝트 경험 학력 있음.';
const BACKEND_COVER = '서버 개발자로 지원합니다. 조회가 느린 문제가 있었고 제가 쿼리를 분석해 인덱스를 추가했습니다. 열심히 하겠습니다. 최선을 다하겠습니다.';

let app;
before(async () => { app = await createApp({ dbFile: ':memory:', env: { LLM_PROVIDER: 'off' } }); });

// ── 텍스트·개인정보 ─────────────────────────────────────────────────────
test('FR-01 개인정보(전화·이메일·주민번호)가 저장 전에 마스킹된다', () => {
  const { masked, found } = maskPII('010-1234-5678 / a.b@test.co.kr / 900101-1234567');
  assert.ok(!/1234-5678|a\.b@|1234567/u.test(masked));
  assert.deepEqual(found.sort(), ['이메일', '전화번호', '주민등록번호'].sort());
});

test('토크나이저: 조사가 달라도 같은 어간 토큰이 나온다', () => {
  assert.ok(tokens('백엔드를').includes('w:백엔드') && tokens('백엔드는').includes('w:백엔드'));
});

// ── 프로필 분석 ──────────────────────────────────────────────────────────
test('역량 매칭: java가 javascript 안에서 잘못 잡히지 않는다(경계 검사)', () => {
  assert.equal(hasAlias('javascript로 개발', 'java'), false);
  assert.equal(hasAlias('java로 개발', 'java'), true);
  assert.equal(hasAlias('스프링을 사용', '스프링'), true); // 한글은 조사 허용
});

test('정량 표현 감지: 숫자+단위, 전후 비교는 인식하고 연도만 있는 문장은 제외한다', () => {
  assert.ok(isQuantified('응답 시간을 1.2초에서 0.3초로 줄였습니다'));
  assert.ok(isQuantified('고객 문의 600건을 분류했습니다'));
  assert.ok(!isQuantified('2023년에 졸업했습니다'));
});

test('analyzeDocs: 상투 표현·정량 문장·이력서 항목을 구분해 낸다', () => {
  const d = analyzeDocs({ resume: BACKEND_RESUME, cover: BACKEND_COVER });
  assert.ok(d.quantified.length >= 1);
  assert.ok(d.weak.some((w) => w.phrases.includes('열심히')));
  assert.ok(d.sections.education && d.sections.skills);
});

// ── 추천(FR-02) ──────────────────────────────────────────────────────────
test('FR-02 백엔드 문서는 백엔드 직무를 1순위로 추천하고 근거(핵심 역량·청크)를 제시한다', async () => {
  const r = await recommendJobs(analyzeDocs({ resume: BACKEND_RESUME, cover: BACKEND_COVER }), app.retriever);
  assert.equal(r.recommendations[0].jobId, 'backend');
  assert.equal(r.recommendations.length, 3);
  assert.ok(r.recommendations[0].coreMatched.length >= 4);
  assert.ok(r.recommendations[0].evidence.length >= 1);
  assert.ok(r.recommendations.every((x) => x.fit >= 0 && x.fit <= 100));
});

test('FR-02 직무 단서가 거의 없는 문서는 신뢰도 low로 안내한다', async () => {
  const r = await recommendJobs(analyzeDocs({ resume: '저는 성실합니다. 잘 부탁드립니다.', cover: '' }), app.retriever);
  assert.equal(r.confidence.level, 'low');
});

test('FR-02 직무 13종 모두 자기 직무의 핵심 역량 문장을 넣으면 1순위가 된다(사전 자체 점검)', async () => {
  for (const job of JOBS) {
    const text = `${job.core.map((c) => c.aliases[0]).join(', ')} 경험이 있습니다. ${job.verbs.join(' ')} 업무를 했습니다.`;
    const r = await recommendJobs(analyzeDocs({ resume: text, cover: '' }), app.retriever);
    assert.equal(r.recommendations[0].jobId, job.id, `${job.id} 사전 문장이 1순위가 아님 → ${r.recommendations[0].jobId}`);
  }
});

// ── 점검(FR-03) ──────────────────────────────────────────────────────────
test('FR-03 점검: 항목 8개·합계 100점 만점·항목마다 근거 가이드가 붙는다', async () => {
  const { userId = 'user-test-01' } = {};
  const sub = await app.analyze(userId, BACKEND_RESUME, BACKEND_COVER);
  const rv = await app.review(userId, sub.submissionId, 'backend');
  assert.equal(rv.items.length, 8);
  assert.equal(rv.items.reduce((s, i) => s + i.max, 0), 100);
  assert.ok(rv.score >= 0 && rv.score <= 100);
  assert.ok(rv.items.every((i) => i.guide?.id));
  // 상투 표현이 있는 입력이므로 해당 항목은 보완 대상이어야 함
  assert.notEqual(rv.items.find((i) => i.id === 'weak').severity, 'ok');
});

test('FR-03 점검: 같은 직무 기준 점검은 좋은 문서가 나쁜 문서보다 높은 점수를 받는다', async () => {
  const good = await app.analyze('user-test-02', BACKEND_RESUME, BACKEND_COVER + ' 그 결과 응답 시간이 1.2초에서 0.3초로 줄었고 팀 성과를 인정받았습니다.');
  const bad = await app.analyze('user-test-02', '열심히 했습니다. 잘 배우겠습니다. 최선을 다하겠습니다. 성실합니다. 책임감이 강합니다.', '저는 성실하고 열정이 있어서 어디서든 잘할 수 있습니다. 귀사에 도움이 되고 싶습니다. 열심히 노력하겠습니다.');
  const a = await app.review('user-test-02', good.submissionId, 'backend');
  const b = await app.review('user-test-02', bad.submissionId, 'backend');
  assert.ok(a.score > b.score + 20, `${a.score} vs ${b.score}`);
});

test('NFR 보안: 다른 사용자의 제출·점검 결과는 조회할 수 없다(IDOR 방지)', async () => {
  const sub = await app.analyze('owner-user-1', BACKEND_RESUME, BACKEND_COVER);
  await assert.rejects(() => app.review('other-user-1', sub.submissionId, 'backend'), /찾을 수 없습니다/u);
  const rv = await app.review('owner-user-1', sub.submissionId, 'backend');
  await assert.rejects(() => app.revise('other-user-1', rv.reviewId, false), /찾을 수 없습니다/u);
});

// ── 보완(FR-04) ──────────────────────────────────────────────────────────
test('FR-04 규칙 기반 보완: 사실은 보존하고 빈칸([ ])만 추가하며 새 숫자를 만들지 않는다', async () => {
  const sub = await app.analyze('user-test-03', BACKEND_RESUME, BACKEND_COVER);
  const rv = await app.review('user-test-03', sub.submissionId, 'backend');
  const out = await app.revise('user-test-03', rv.reviewId, false);
  assert.ok(out.suggestions.length >= 1);
  assert.ok(out.suggestions.every((s) => s.method === 'rule' && /\[/u.test(s.suggestion)));
  for (const s of out.suggestions) assert.equal(validateRewrite(s.suggestion, s.original, BACKEND_RESUME + BACKEND_COVER), null);
});

test('FR-04 검증(guard): 원문에 없는 숫자·기술이 들어간 AI 결과는 거절한다', () => {
  const doc = 'Java와 Spring으로 API를 개발했습니다.';
  assert.match(validateRewrite('Java로 API를 개발해 응답 시간을 40% 줄였습니다.', doc, doc), /원문에 없는 숫자/u);
  assert.match(validateRewrite('Java와 Kubernetes로 API를 개발했습니다.', doc, doc), /원문에 없는 기술/u);
  assert.equal(validateRewrite('Java와 Spring으로 API를 개발했으며 성과 [수치 입력]을 정리했습니다.', doc, doc), null);
  assert.match(validateRewrite('죄송하지만 도와드릴 수 없습니다.', doc, doc), /거절/u);
});

test('FR-04 LLM 경로: 가짜 LLM이 정상 문장을 주면 채택, 날조 문장을 주면 규칙 기반으로 대체', async () => {
  const mk = (reply) => new LLM({ env: {}, provider: 'ollama', fetchFn: async (url) => (String(url).endsWith('/api/tags')
    ? { ok: true, json: async () => ({ models: [{ name: 'kanana2:3b' }] }) }
    : { ok: true, json: async () => ({ message: { content: reply } }) }) });
  const run = async (reply, user) => {
    const llm = await mk(reply).init();
    const a = await createApp({ dbFile: ':memory:', env: {}, llm });
    const sub = await a.analyze(user, BACKEND_RESUME, BACKEND_COVER);
    const rv = await a.review(user, sub.submissionId, 'backend');
    return a.revise(user, rv.reviewId, true);
  };
  const good = await run('Java와 Spring 경험을 바탕으로 맡은 역할과 결과 [수치 입력]를 구체적으로 정리해 지원합니다.', 'user-llm-ok1');
  assert.ok(good.suggestions.some((s) => s.method === 'llm'));
  const bad = await run('Kubernetes로 서버 비용을 73% 절감했습니다.', 'user-llm-bad');
  assert.ok(bad.suggestions.every((s) => s.method === 'rule' && s.note));
});

test('LLM 어댑터: 키·서버가 없으면 available=false, 오류 메시지에 키가 노출되지 않는다', async () => {
  const none = await new LLM({ env: {}, fetchFn: async () => { throw new Error('down'); } }).init();
  assert.equal(none.available, false);
  const llm = await new LLM({ env: { ANTHROPIC_API_KEY: 'sk-secret-123' }, fetchFn: async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }) }).init();
  await assert.rejects(() => llm.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }));
  assert.ok(!String(llm.lastError).includes('sk-secret'));
});

test('보완 대상 선정: 지원 동기 문장은 "수치 없음"으로 잡지 않는다', () => {
  const d = analyzeDocs({ resume: '', cover: '저는 서버 개발자로 지원합니다. Spring으로 API를 개발했습니다.' });
  const t = pickTargets(d).map((x) => x.original);
  assert.ok(!t.some((s) => s.includes('지원합니다')));
  assert.ok(t.some((s) => s.includes('API를 개발했습니다')));
});

// ── HTTP API(FR-05, NFR) ─────────────────────────────────────────────────
let server, base;
before(async () => {
  // 주의: app 생성이 끝난 뒤에 서버를 만들어야 합니다(훅 실행 순서에 기대지 않고 직접 기다림).
  app ??= await createApp({ dbFile: ':memory:', env: { LLM_PROVIDER: 'off' } });
  server = createServer(createHandler(app, { minGapMs: 0 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('API: 분석 → 점검 → 보완 → 평가 → 기록 → 지표 흐름이 이어진다', async () => {
  const uid = 'api-user-0001';
  const a = await (await post('/api/analyze', { userId: uid, resume: BACKEND_RESUME, cover: BACKEND_COVER })).json();
  assert.equal(a.recommendations[0].jobId, 'backend');
  const r = await (await post('/api/review', { userId: uid, submissionId: a.submissionId, jobId: 'backend' })).json();
  assert.ok(r.score >= 0);
  const v = await (await post('/api/revise', { userId: uid, reviewId: r.reviewId, useLlm: false })).json();
  assert.ok(v.suggestions.length >= 1);
  const f = await post('/api/feedback', { userId: uid, type: 'revision', targetId: v.suggestions[0].revisionId, helpful: true });
  assert.equal(f.status, 200);
  const hist = await (await fetch(`${base}/api/history?userId=${uid}`)).json();
  assert.equal(hist[0].reviews.length, 1);
  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.ok(stats.submissions >= 1 && stats.feedback.total >= 1);
});

test('API 입력 검증: 너무 짧음 400 · userId 없음 400 · 알 수 없는 직무 400 · 너무 김 413', async () => {
  assert.equal((await post('/api/analyze', { userId: 'api-user-0002', resume: '짧음', cover: '' })).status, 400);
  assert.equal((await post('/api/analyze', { resume: BACKEND_RESUME })).status, 400);
  const a = await (await post('/api/analyze', { userId: 'api-user-0002', resume: BACKEND_RESUME, cover: '' })).json();
  assert.equal((await post('/api/review', { userId: 'api-user-0002', submissionId: a.submissionId, jobId: 'nope' })).status, 400);
  assert.equal((await post('/api/analyze', { userId: 'api-user-0002', resume: 'x'.repeat(70000) })).status, 413);
});

test('API 보안: 정적 파일 경로 이탈 차단 · 보안 헤더 · 사용자 간 격리', async () => {
  assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404);
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/u);
  const a = await (await post('/api/analyze', { userId: 'api-owner-01', resume: BACKEND_RESUME, cover: '' })).json();
  assert.equal((await post('/api/review', { userId: 'api-other-01', submissionId: a.submissionId, jobId: 'backend' })).status, 404);
});

test('API 남용 방지: 같은 사용자의 연속 호출은 429', async () => {
  const s2 = createServer(createHandler(app, { minGapMs: 60000 }));
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const body = JSON.stringify({ userId: 'rate-user-01', resume: BACKEND_RESUME, cover: '' });
  const call = () => fetch(b2 + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429);
  s2.close();
});

test('개인정보: DB에는 마스킹된 텍스트만 저장된다', async () => {
  const sub = await app.analyze('pii-user-001', `${BACKEND_RESUME} 연락처 010-9999-8888 이메일 me@test.com`, '');
  const row = app.store.getSubmission(sub.submissionId, 'pii-user-001');
  assert.ok(!/9999-8888|me@test/u.test(row.resume_text));
  assert.ok(sub.pii.includes('전화번호') && sub.pii.includes('이메일'));
});

test('ruleRewrite: 문서에 없는 기술을 추천하지 않는다', () => {
  const job = JOBS.find((j) => j.id === 'backend');
  const docs = analyzeDocs({ resume: '', cover: '열심히 했습니다. Python으로 스크립트를 만들었습니다.' });
  const s = ruleRewrite({ original: '열심히 했습니다.', issue: '막연한 표현(열심히)' }, job, docs);
  assert.ok(!/Spring|Java|Docker/u.test(s));
  assert.ok(findSkills(s, job.core).every((x) => x.name === 'Python'));
});

test('NFR 안정성: 같은 DB 파일로 서버를 다시 시작해도(기록이 있어도) 기준 데이터 동기화가 실패하지 않는다', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'jm-test-'));
  const file = join(dir, 'restart.db');
  const first = await createApp({ dbFile: file, env: { LLM_PROVIDER: 'off' } });
  const sub = await first.analyze('restart-user-1', BACKEND_RESUME, BACKEND_COVER); // 직무를 참조하는 기록 생성
  await first.review('restart-user-1', sub.submissionId, 'backend');
  first.store.db.close();
  const second = await createApp({ dbFile: file, env: { LLM_PROVIDER: 'off' } }); // 재시작: 예외가 나면 안 됨
  assert.equal(second.store.history('restart-user-1').length, 1);
  second.store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('정량 표현: 근무·수강 "기간"(5개월, 3년, 2026.07)은 성과 수치로 세지 않는다', () => {
  assert.ok(!isQuantified('2022.11 ~ 2023.03 (5개월) 스마트인재개발원 과정 수료'));
  assert.ok(!isQuantified('쏘카에서 3년간 차량을 배달했습니다.'));
  assert.ok(!isQuantified('2023.07 ~ 2026.07 (3년) 아르바이트'));
  assert.ok(!isQuantified('광주비엔날레 전시·스태프 3개월 근무'));
});

test('정량 표현: 기간이 "성과"로 쓰이면(전후 비교·단축 동사) 여전히 성과 수치로 센다', () => {
  assert.ok(isQuantified('배포 준비 기간을 3개월에서 1개월로 줄였습니다.'));
  assert.ok(isQuantified('릴리스 주기를 2개월 단축했습니다.'));
  assert.ok(isQuantified('응답 시간을 1.2초에서 0.3초로 줄였습니다.'));
  assert.ok(isQuantified('문의 600건을 분류했습니다.'));
});

test('analyzeDocs: 기간만 가득한 경력 이력서는 성과 문장 0개, 성과가 있으면 그 문장만 센다', () => {
  const periodOnly = analyzeDocs({ resume: ['2021.07 ~ 2022.09 (1년 2개월) 부품 납품 재고관리', '2023.07 ~ 2026.07 (3년) 차량 배달'].join('\n'), cover: '' });
  assert.equal(periodOnly.quantified.length, 0);
  const withResult = analyzeDocs({ resume: ['2023.07 ~ 2026.07 (3년) 차량 배달', '재고 오차를 12건에서 3건으로 줄였습니다.'].join('\n'), cover: '' });
  assert.equal(withResult.quantified.length, 1);
});

test('모의 평가에서 발견한 결함: 빈칸 표시 [지표]가 있어도 정상 AI 제안을 날조로 오인해 거절하지 않는다', () => {
  const doc = '인스타그램 계정을 운영했습니다.';
  assert.equal(validateRewrite('인스타그램 계정을 운영해 [지표]를 [이전 값]에서 [이후 값]으로 개선했습니다.', doc, doc), null);
  // 빈칸 밖에 새 숫자·기술이 있으면 여전히 거절
  assert.match(validateRewrite('인스타그램 계정을 운영해 팔로워를 40% 늘렸습니다. [지표]', doc, doc), /원문에 없는 숫자/u);
});

test('모의 평가에서 발견한 결함: 같은 이름의 역량은 직무별 별칭을 합쳐서 인식한다(커뮤니케이션 = 면담·조율·공감 …)', () => {
  assert.ok(findSkills('학생 면담으로 의견을 조율했습니다.', ALL_SKILLS).some((s) => s.name === '커뮤니케이션'));
  assert.ok(findSkills('고객의 불만에 공감하며 설명했습니다.', ALL_SKILLS).some((s) => s.name === '커뮤니케이션'));
});

test('모의 평가에서 발견한 결함: 규칙 보완은 도구·기술(영문 이름)만 "활용해"로 쓰고 업무 역량(고객 응대)은 쓰지 않는다', () => {
  const job = JOBS.find((j) => j.id === 'cs');
  const docsCs = analyzeDocs({ resume: '', cover: '고객 응대를 했습니다. 항상 최선을 다했습니다.' });
  const s1 = ruleRewrite({ original: '항상 최선을 다했습니다.', issue: '막연한 표현(최선)' }, job, docsCs);
  assert.ok(!s1.includes('고객 응대을') && !s1.includes('고객 응대를 활용') && s1.includes('[사용한 도구·방법]'));
  const jobBe = JOBS.find((j) => j.id === 'backend');
  const docsBe = analyzeDocs({ resume: '', cover: 'Java로 API를 만들었습니다. 열심히 했습니다.' });
  assert.ok(ruleRewrite({ original: '열심히 했습니다.', issue: '막연한 표현(열심히)' }, jobBe, docsBe).includes('Java을(를) 활용해'));
});
