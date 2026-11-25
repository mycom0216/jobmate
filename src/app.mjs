// ─────────────────────────────────────────────────────────────────────────────
// app.mjs — 서비스 조립(Composition Root) 및 핵심 업무 흐름(use case)
//
// [역할]
//   각 모듈(검색기·LLM·DB·분석·추천·점검·보완)을 한 곳에서 만들어 서로 연결합니다.
//   http.mjs는 "요청을 받아 이 서비스의 함수를 부르는 얇은 층"이고, 실제 업무 규칙은 여기와 각 모듈에 있습니다.
//   → 웹 서버 없이도(테스트에서) 같은 로직을 호출할 수 있어 검증이 쉽습니다(관심사 분리).
// ─────────────────────────────────────────────────────────────────────────────
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { JOBS } from '../knowledge/jobs.mjs';
import { openDb, Store } from './db.mjs';
import { buildChunks } from './kb.mjs';
import { LLM } from './llm.mjs';
import { analyzeDocs } from './profile.mjs';
import { Retriever } from './rag.mjs';
import { recommendJobs } from './recommend.mjs';
import { reviseDocs } from './revise.mjs';
import { reviewDocs } from './review.mjs';
import { maskPII } from './text.mjs';
import { HttpError } from './errors.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 입력 한도: 너무 긴 입력은 처리 시간·외부 LLM 비용·악용(서비스 거부) 위험을 키웁니다.
export const LIMITS = { minChars: 80, maxChars: 12000 };

export async function createApp({ dbFile = join(ROOT, 'data', 'jobmate.db'), env = process.env, llm, useEmbeddings = env.EMBEDDINGS === 'on' } = {}) {
  if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });
  const store = new Store(openDb(dbFile));
  const chunks = buildChunks();
  store.syncReference(JOBS, chunks);

  const retriever = await new Retriever(chunks, { useEmbeddings, cacheFile: dbFile === ':memory:' ? null : join(ROOT, 'data', 'embeddings.json') }).init();
  const llmClient = llm ?? (await new LLM({ env }).init());

  // 입력 검증 + 개인정보 마스킹. 반환: 분석에 쓸 안전한 문서
  function prepare(resume, cover) {
    const r = maskPII(String(resume ?? '').slice(0, LIMITS.maxChars + 1));
    const c = maskPII(String(cover ?? '').slice(0, LIMITS.maxChars + 1));
    if (r.masked.length > LIMITS.maxChars || c.masked.length > LIMITS.maxChars) throw new HttpError(413, `각 문서는 ${LIMITS.maxChars}자 이하로 입력해 주세요.`);
    const total = (r.masked + c.masked).replace(/\s+/gu, '').length;
    if (total < LIMITS.minChars) throw new HttpError(400, `내용이 너무 짧습니다. 이력서·자기소개서를 합쳐 ${LIMITS.minChars}자 이상 입력해 주세요.`);
    return { resume: r.masked, cover: c.masked, pii: [...new Set([...r.found, ...c.found])] };
  }

  return {
    store, chunks, retriever, llm: llmClient, jobs: JOBS,

    // 1단계: 문서 제출 → 분석 → 직무 추천
    async analyze(userId, resume, cover) {
      const p = prepare(resume, cover);
      const docs = analyzeDocs(p);
      const result = await recommendJobs(docs, retriever);
      const submissionId = store.saveSubmission(userId, p.resume, p.cover, p.pii);
      const recIds = store.saveRecommendations(submissionId, result.recommendations);
      result.recommendations.forEach((r, i) => { r.recId = recIds[i]; });
      return {
        submissionId, pii: p.pii, ...result,
        summary: { resumeChars: docs.resumeLen, coverChars: docs.coverLen, quantified: docs.quantified.length },
      };
    },

    // 2단계: 선택한 직무 기준으로 점검
    async review(userId, submissionId, jobId) {
      const sub = store.getSubmission(submissionId, userId);
      if (!sub) throw new HttpError(404, '제출한 문서를 찾을 수 없습니다.');
      if (!JOBS.some((j) => j.id === jobId)) throw new HttpError(400, '알 수 없는 직무입니다.');
      const docs = analyzeDocs({ resume: sub.resume_text, cover: sub.cover_text });
      const review = await reviewDocs(docs, jobId, retriever);
      review.reviewId = store.saveReview(submissionId, review);
      return review;
    },

    // 3단계: 보완 제안(문장 재작성) — 점검 결과(reviewId)에 연결해 저장
    async revise(userId, reviewId, useLlm = true) {
      const rv = store.getReview(reviewId, userId);
      if (!rv) throw new HttpError(404, '점검 결과를 찾을 수 없습니다.');
      const sub = store.getSubmission(rv.submission_id, userId);
      const docs = analyzeDocs({ resume: sub.resume_text, cover: sub.cover_text });
      const out = await reviseDocs(docs, rv.job_id, { retriever, llm: llmClient, useLlm });
      out.reviewId = reviewId;
      const ids = store.saveRevisions(reviewId, out.suggestions);
      out.suggestions.forEach((s, i) => { s.revisionId = ids[i]; });
      return out;
    },
  };
}
