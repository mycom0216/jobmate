// ─────────────────────────────────────────────────────────────────────────────
// kb.mjs — 지식베이스(Knowledge Base) 구성: 직무 데이터 → 검색 가능한 "청크" 목록
//
// [청크(chunk)란?]
//   RAG는 긴 문서를 통째로 검색하지 않고 "의미 단위로 잘게 나눈 조각"을 검색합니다.
//   왜? ① 질문과 관련된 부분만 정확히 골라 LLM에 넘겨 환각을 줄이고,
//        ② 화면에 "어느 조각을 근거로 삼았는지" 출처를 보여 줄 수 있기 때문입니다.
//
// [이 프로젝트의 청크 구성]
//   직무 13종 × 4종(개요/이력서/자소서/감점 요인) = 52개  +  공통 가이드 8개  = 총 60개
//   청크 ID 예: BACKEND-02 (백엔드 직무의 이력서 작성 가이드), GEN-01 (공통 원칙)
// ─────────────────────────────────────────────────────────────────────────────
import { GENERAL_GUIDES, JOBS } from '../knowledge/jobs.mjs';

const KINDS = [
  ['overview', '직무 개요', 1],
  ['resume', '이력서 작성 포인트', 2],
  ['cover', '자기소개서 작성 포인트', 3],
  ['pitfall', '흔한 감점 요인과 보완', 4],
];

// 직무 데이터에서 청크 배열을 만듭니다.
// 각 청크: { id, jobId, kind, title, text }  — jobId가 null이면 공통 가이드
export function buildChunks(jobs = JOBS, general = GENERAL_GUIDES) {
  const chunks = [];
  for (const job of jobs) {
    for (const [kind, label, n] of KINDS) {
      chunks.push({
        id: `${job.id.toUpperCase()}-0${n}`,
        jobId: job.id,
        kind,
        title: `${job.name} — ${label}`,
        // 직무 이름과 핵심 기술 이름을 본문 앞에 붙입니다.
        // 왜? 검색은 글자 일치 기반이라, 본문에 "Spring"이 없어도 직무 청크가 Spring 질의에 걸리도록
        // 핵심 기술 어휘를 청크에 함께 담아 두면 검색 재현율이 올라갑니다.
        text: `${job.guide[kind]}${kind === 'overview' ? ` 핵심 역량: ${job.core.map((c) => c.name).join(', ')}.` : ''}`,
      });
    }
  }
  for (const g of general) chunks.push({ id: g.id, jobId: null, kind: 'general', title: g.title, text: g.text });
  return chunks;
}

// 직무 id로 직무 객체를 찾습니다. 없으면 undefined.
export const jobById = (id, jobs = JOBS) => jobs.find((j) => j.id === id);
