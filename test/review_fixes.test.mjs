// ─────────────────────────────────────────────────────────────────────────────
// review_fixes.test.mjs — 코드 전체 검토에서 발견한 결함의 회귀 테스트 + 검토 중 확인된 미검증 경로(GET API, 임베딩 검색) 테스트
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, before, after } from 'node:test';
import { createApp } from '../src/app.mjs';
import { createHandler } from '../src/http.mjs';
import { LLM } from '../src/llm.mjs';
import { analyzeDocs } from '../src/profile.mjs';
import { Retriever } from '../src/rag.mjs';
import { recommendJobs } from '../src/recommend.mjs';
import { buildChunks } from '../src/kb.mjs';
import { reviseDocs } from '../src/revise.mjs';

const RESUME = '컴퓨터공학 졸업. Java, Spring, SQL, Git 경험. 서버 API를 개발했습니다. 프로젝트 경험 학력 자격 기술 보유.';
const COVER = '서버 개발자로 지원합니다. 조회가 느린 문제를 쿼리 분석으로 해결했습니다. 열심히 하겠습니다.';
const POSTING = ['백엔드 개발자', '자격 요건', '- 학사 이상', '- Java 개발 경험', '- SQL 활용 능력'].join('\n');

let app, server, base;
before(async () => {
  app = await createApp({ dbFile: ':memory:', env: { LLM_PROVIDER: 'off' } });
  server = createServer(createHandler(app, { minGapMs: 0 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 가짜 LLM: reply를 그대로 돌려줍니다(외부 호출 없음).
const fakeLlm = (reply) => ({ available: true, label: 'fake', complete: async () => reply });

test('검토 결함: 제안 문장에 "$&" 같은 특수 패턴이 있어도 원문 교체 미리보기에 글자 그대로 들어간다', async () => {
  const docs = analyzeDocs({ resume: RESUME, cover: '열심히 했습니다. 항상 최선을 다했습니다.' });
  const out = await reviseDocs(docs, 'backend', { retriever: app.retriever, llm: fakeLlm('Java로 API를 개발해 $& 결과를 [수치 입력]으로 정리했습니다.'), useLlm: true });
  const adopted = out.suggestions.find((s) => s.method === 'llm');
  assert.ok(adopted, 'AI 제안이 채택되어야 함');
  assert.ok(out.revisedCover.includes('$& 결과'), '특수 패턴이 해석되지 않고 글자 그대로여야 함');
  assert.ok(!out.revisedCover.includes(adopted.original), '원문 문장은 교체되어 사라져야 함');
});

test('검토 결함: LLM 응답이 빈 줄로 시작해도 내용이 있는 첫 줄을 제안으로 쓴다', async () => {
  const docs = analyzeDocs({ resume: RESUME, cover: '열심히 했습니다. 항상 최선을 다했습니다.' });
  const out = await reviseDocs(docs, 'backend', { retriever: app.retriever, llm: fakeLlm('\n\nJava와 Spring으로 API를 개발해 [수치 입력]를 정리했습니다.'), useLlm: true });
  assert.ok(out.suggestions.some((s) => s.method === 'llm'));
});

test('검토 결함: 공고에 "학력 무관"이나 "대졸 우대"가 있으면 학력을 미충족 가능으로 단정하지 않는다', async () => {
  const sub = await app.analyze('review-user-1', RESUME.replace('컴퓨터공학 졸업', '고등학교 졸업'), COVER);
  const strict = await app.posting('review-user-1', sub.submissionId, POSTING);
  assert.equal(strict.conditions.find((c) => c.type === '학력').status, 'likely-unmet'); // 필수 요건 → 단정
  const free = await app.posting('review-user-1', sub.submissionId, POSTING.replace('- 학사 이상', '- 학력 무관 (대졸 우대)'));
  assert.equal(free.conditions.find((c) => c.type === '학력').status, 'check');
});

test('검토 결함: 이력서가 길어도 자소서가 추천 검색 질의에 반영된다', async () => {
  let seen = '';
  const spy = { search: async (q) => { seen = q; return []; } };
  const docs = analyzeDocs({ resume: '가'.repeat(5000), cover: '서버 개발자로 지원합니다 고유문구XYZ' });
  await recommendJobs(docs, spy).catch(() => {}); // 가짜 검색기는 결과가 없어도 질의 확인이 목적
  assert.ok(seen.includes('고유문구XYZ'), '자소서가 4,000자 앞부분 절단으로 사라지면 안 됨');
});

test('검토 결함: 한글 12,000자씩 두 문서(UTF-8 약 72KB)도 본문 한도(413)에 걸리지 않고 처리된다', async () => {
  const doc = '서버를 설계하고 데이터베이스 쿼리를 분석해 응답 속도를 개선했습니다. '.repeat(400).slice(0, 12000);
  const res = await post('/api/analyze', { userId: 'big-doc-user-1', resume: doc, cover: doc });
  assert.equal(res.status, 200);
});

test('검토 결함: 제출과 추천 저장은 한 트랜잭션 — 추천 저장이 실패하면 제출도 남지 않는다', () => {
  const before = app.store.db.prepare('SELECT COUNT(*) n FROM submissions').get().n;
  const badRec = { jobId: 'no-such-job', rank: 1, fit: 1, parts: {}, coreMatched: [], coreMissing: [] }; // 외래키 위반
  assert.throws(() => app.store.saveAnalysis('atomic-user-1', 'a', 'b', [], [badRec]));
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM submissions').get().n, before);
});

// ── 미검증이던 경로 ───────────────────────────────────────────────────────
test('GET API: 상태·직무 목록·직무 가이드·지식 검색·샘플·지표·기록이 응답한다', async () => {
  const json = async (p) => { const r = await fetch(base + p); assert.equal(r.status, 200, p); return r.json(); };
  assert.equal((await json('/api/status')).jobs, 13);
  assert.equal((await json('/api/jobs')).length, 13);
  const guide = await json('/api/jobs/guide?id=backend');
  assert.equal(guide.guides.length, 4);
  assert.ok((await json('/api/kb/search?q=' + encodeURIComponent('백엔드 API 설계'))).length > 0);
  assert.ok(typeof (await json('/api/sample')) === 'object');
  assert.ok('submissions' in (await json('/api/stats')));
  assert.ok(Array.isArray(await json('/api/history?userId=review-user-1')));
  assert.equal((await fetch(base + '/api/jobs/guide?id=nope')).status, 404);
});

test('임베딩 하이브리드 검색: 가짜 임베딩 서버로 색인·캐시·검색 경로를 검증한다(실제 모델 품질은 검증 아님)', async () => {
  // 키워드 포함 여부로 2차원 벡터를 만드는 가짜 Ollama /api/embed 서버
  const vec = (t) => [/백엔드|서버|api/iu.test(t) ? 1 : 0.05, /디자인|화면|ux/iu.test(t) ? 1 : 0.05];
  let calls = 0;
  const fake = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { calls++; const { input } = JSON.parse(body); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ embeddings: input.map(vec) })); });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    const r = await new Retriever(buildChunks(), { useEmbeddings: true, ollamaUrl: `http://127.0.0.1:${fake.address().port}` }).init();
    assert.equal(r.mode, 'hybrid(BM25+embedding)');
    const hits = await r.search('서버 API 개발', 3);
    assert.ok(hits.length === 3 && hits.every((h) => h.cosine !== null));
    assert.ok(calls >= 2); // 색인 1회 + 질의 1회
    // 임베딩 서버가 죽으면 BM25로 조용히 돌아간다
    const dead = await new Retriever(buildChunks(), { useEmbeddings: true, ollamaUrl: 'http://127.0.0.1:1' }).init();
    assert.equal(dead.mode, 'BM25');
  } finally { fake.close(); }
});

test('LLM 어댑터: OpenAI·Anthropic 응답 형식을 파싱한다(가짜 서버, 실제 호출 아님)', async () => {
  const mk = (provider, payload) => new LLM({ env: provider === 'anthropic' ? { ANTHROPIC_API_KEY: 'k' } : { OPENAI_API_KEY: 'k' }, provider,
    fetchFn: async () => ({ ok: true, json: async () => payload, text: async () => '' }) });
  const a = await mk('anthropic', { content: [{ type: 'text', text: '안녕' }] }).init();
  assert.equal(await a.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }), '안녕');
  const o = await mk('openai', { choices: [{ message: { content: '반갑습니다' } }] }).init();
  assert.equal(await o.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }), '반갑습니다');
});

// ── 기록 삭제(FR-10) ─────────────────────────────────────────────────────
const countAll = (uid) => {
  const q = (sql) => app.store.db.prepare(sql).get(uid).n;
  return {
    users: q('SELECT COUNT(*) n FROM users WHERE user_id=?'),
    submissions: q('SELECT COUNT(*) n FROM submissions WHERE user_id=?'),
    recs: q('SELECT COUNT(*) n FROM recommendations r JOIN submissions s ON s.submission_id=r.submission_id WHERE s.user_id=?'),
    reviews: q('SELECT COUNT(*) n FROM reviews r JOIN submissions s ON s.submission_id=r.submission_id WHERE s.user_id=?'),
    items: q('SELECT COUNT(*) n FROM review_items i JOIN reviews r ON r.review_id=i.review_id JOIN submissions s ON s.submission_id=r.submission_id WHERE s.user_id=?'),
    revisions: q('SELECT COUNT(*) n FROM revisions v JOIN reviews r ON r.review_id=v.review_id JOIN submissions s ON s.submission_id=r.submission_id WHERE s.user_id=?'),
    postings: q('SELECT COUNT(*) n FROM posting_checks p JOIN submissions s ON s.submission_id=p.submission_id WHERE s.user_id=?'),
    feedback: q('SELECT COUNT(*) n FROM feedback WHERE user_id=?'),
  };
};

test('FR-10 기록 삭제: 내 제출·추천·점검·항목·보완·공고·피드백이 전부 지워지고 다른 사용자 기록은 그대로다', async () => {
  const mine = 'forget-me-0001', other = 'forget-other-001';
  for (const uid of [mine, other]) {
    const sub = await app.analyze(uid, RESUME, COVER);
    const rv = await app.review(uid, sub.submissionId, 'backend');
    await app.revise(uid, rv.reviewId, false);
    await app.posting(uid, sub.submissionId, POSTING);
    app.store.saveFeedback(uid, 'review', rv.reviewId, true);
  }
  const before = countAll(mine);
  assert.ok(Object.values(before).every((n) => n > 0), JSON.stringify(before)); // 모든 종류의 데이터가 실제로 있었음
  const otherBefore = countAll(other);

  const deleted = app.store.deleteUser(mine);
  assert.equal(deleted.submissions, 1);
  assert.ok(deleted.reviews === 1 && deleted.revisions >= 1 && deleted.postings === 1 && deleted.feedback === 1);
  assert.ok(Object.values(countAll(mine)).every((n) => n === 0), '내 데이터가 어디에도 남으면 안 됨');
  assert.deepEqual(countAll(other), otherBefore); // 다른 사용자는 영향 없음
  // 멱등: 이미 없는 사용자에게 다시 호출해도 오류 없이 0건
  assert.deepEqual(app.store.deleteUser(mine), { submissions: 0, reviews: 0, revisions: 0, postings: 0, feedback: 0 });
});

test('FR-10 API: confirm 없으면 400(삭제 안 됨), confirm:true면 삭제되고 기록이 비며, 삭제 후에도 같은 ID로 다시 쓸 수 있다', async () => {
  const uid = 'api-forget-001';
  const a = await (await post('/api/analyze', { userId: uid, resume: RESUME, cover: COVER })).json();
  assert.equal((await post('/api/forget', { userId: uid })).status, 400);
  assert.equal((await post('/api/forget', { userId: uid, confirm: 'yes' })).status, 400); // true(불리언)만 인정
  assert.equal((await post('/api/forget', { userId: 'x', confirm: true })).status, 400);   // userId 형식 오류
  assert.equal((await (await fetch(`${base}/api/history?userId=${uid}`)).json()).length, 1); // 아직 안 지워짐

  const res = await post('/api/forget', { userId: uid, confirm: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted.submissions, 1);
  assert.deepEqual(await (await fetch(`${base}/api/history?userId=${uid}`)).json(), []);
  // 삭제 후 제출번호로 접근하면 404
  assert.equal((await post('/api/review', { userId: uid, submissionId: a.submissionId, jobId: 'backend' })).status, 404);
  // 같은 ID로 새로 시작할 수 있음
  assert.equal((await post('/api/analyze', { userId: uid, resume: RESUME, cover: COVER })).status, 200);
});
