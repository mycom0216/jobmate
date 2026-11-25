// ─────────────────────────────────────────────────────────────────────────────
// posting.test.mjs — 채용 공고 기반 점검(FR-09) 자동 테스트
// 실행: node --test test/   (다른 테스트 파일과 별도 DB(메모리)를 쓰므로 서로 영향이 없습니다)
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, before, after } from 'node:test';
import { createApp } from '../src/app.mjs';
import { createHandler } from '../src/http.mjs';
import { parsePosting } from '../src/posting.mjs';

const RESUME = '학력: 고등학교 졸업\nJava, Spring Boot, MySQL로 주문 API를 개발했습니다. Git으로 협업했습니다.';
const COVER = '서버 개발자로 지원합니다. 조회가 느린 문제를 쿼리 분석으로 해결했습니다.';
const POSTING = [
  '백엔드 개발자 (신입)',
  '주요 업무', '- 서비스 API 설계 및 개발',
  '자격 요건', '- 학사 학위 이상', '- Java 또는 Kotlin 개발 경험', '- RDBMS(MySQL 등) 활용 경험', '- Docker 사용 경험',
  '우대 사항', '- AWS 클라우드 운영 경험',
].join('\n');

let app, server, base;
before(async () => {
  app = await createApp({ dbFile: ':memory:', env: { LLM_PROVIDER: 'off' } });
  server = createServer(createHandler(app, { minGapMs: 0 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('FR-09 공고 파싱: 자격요건·우대사항·담당업무 제목으로 항목을 구분한다', () => {
  const p = parsePosting(POSTING);
  assert.equal(p.sectioned, true);
  assert.equal(p.required.length, 4);
  assert.equal(p.preferred.length, 1);
  assert.equal(p.duty.length, 1);
  assert.equal(p.title, '백엔드 개발자 (신입)');
});

test('FR-09 공고 파싱: 제목이 없으면 모든 줄을 필수로 간주하고 알려 준다', () => {
  const p = parsePosting('Java 개발 경험이 있는 분\nSQL을 다룰 수 있는 분');
  assert.equal(p.sectioned, false);
  assert.equal(p.required.length, 2);
});

test('FR-09 공고 점검: 기술 충족/미충족, 학력 조건 안내, 가까운 직무, 저장', async () => {
  const sub = await app.analyze('posting-user-1', RESUME, COVER);
  const r = await app.posting('posting-user-1', sub.submissionId, POSTING);
  const byText = (t) => r.required.find((i) => i.text.includes(t));
  assert.equal(byText('Java').status, 'met');
  assert.ok(byText('Java').evidence.includes('Java'));
  assert.equal(byText('RDBMS').status, 'met'); // MySQL은 데이터베이스 기술로 인정
  assert.equal(byText('Docker').status, 'missing');
  assert.ok(r.missingSkills.includes('Docker') && r.missingSkills.includes('AWS'));
  assert.equal(r.jobGuess.jobId, 'backend');
  // 학력 줄은 요건 목록에서 빠지고 조건으로 따로 안내된다(대학 학력이 서류에 없으므로 미충족 가능)
  assert.ok(!r.required.some((i) => i.text.includes('학사')));
  assert.equal(r.conditions.find((c) => c.type === '학력').status, 'likely-unmet');
  assert.ok(r.rates.required >= 0 && r.rates.required <= 100);
  assert.ok(r.postingId > 0);
});

test('FR-09 서류에 대학 학력이 있으면 학력은 직접 대조(check)로 안내한다', async () => {
  const sub = await app.analyze('posting-user-2', '학력: 한국대학교 컴퓨터공학과 졸업\nJava로 API를 개발했습니다. 기술 자격 프로젝트 경험이 있습니다. 팀 프로젝트에서 서버 개발을 맡았고 Git으로 협업했습니다.', COVER);
  const r = await app.posting('posting-user-2', sub.submissionId, POSTING);
  assert.equal(r.conditions.find((c) => c.type === '학력').status, 'check');
});

test('FR-09 입력 검증·보안: 짧으면 400, 다른 사용자 제출 404, 공고 속 연락처는 마스킹 저장', async () => {
  const sub = await app.analyze('posting-user-3', RESUME, COVER);
  await assert.rejects(() => app.posting('posting-user-3', sub.submissionId, '짧음'), /너무 짧/u);
  await assert.rejects(() => app.posting('posting-other', sub.submissionId, POSTING), /찾을 수 없/u);
  await app.posting('posting-user-3', sub.submissionId, `${POSTING}\n문의 recruit@corp.com 02-123-4567`);
  const row = app.store.db.prepare('SELECT posting_text FROM posting_checks ORDER BY posting_id DESC LIMIT 1').get();
  assert.ok(!/recruit@corp|123-4567/u.test(row.posting_text));
});

test('FR-09 API: POST /api/posting 정상 응답과 입력 오류 코드', async () => {
  const uid = 'api-posting-01';
  const a = await (await post('/api/analyze', { userId: uid, resume: RESUME, cover: COVER })).json();
  const ok = await post('/api/posting', { userId: uid, submissionId: a.submissionId, posting: POSTING });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).required.length >= 1);
  assert.equal((await post('/api/posting', { userId: uid, submissionId: a.submissionId, posting: '짧음' })).status, 400);
  assert.equal((await post('/api/posting', { userId: uid, submissionId: 'x', posting: POSTING })).status, 400);
});

test('모의 평가에서 발견한 결함: "SQL 활용 능력" 항목이 SQL이 없는 서류를 엉뚱한 역량(데이터 기반 의사결정)으로 충족 처리하지 않는다', async () => {
  const sub = await app.analyze('posting-user-4', '마케팅 인턴 6개월. 인스타그램 콘텐츠를 기획하고 광고를 집행했으며 구글 애널리틱스로 성과 지표를 확인했습니다. 엑셀과 포토샵 사용.', '캠페인 성과를 숫자로 개선하는 마케터가 되고 싶습니다. 클릭률 분석 경험이 있습니다.');
  const r = await app.posting('posting-user-4', sub.submissionId, '마케팅 담당자\n자격 요건\n- SQL 활용 능력\n- GA 등 데이터 분석 툴 활용 능력\n- 콘텐츠 기획 경험');
  const sql = r.required.find((i) => i.text.includes('SQL'));
  assert.equal(sql.status, 'missing');
  assert.deepEqual(sql.skills.map((s) => s.name), ['SQL']);
  assert.equal(r.required.find((i) => i.text.includes('GA')).skills.find((s) => s.name === 'GA').found, true); // 구글 애널리틱스 = GA
});
