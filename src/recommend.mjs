// ─────────────────────────────────────────────────────────────────────────────
// recommend.mjs — 직무 추천: "내 문서가 어떤 직무에 가장 가까운가"
//
// [점수 설계 — 세 가지 신호를 섞은 이유]
//   fit = 0.40 × 역량 일치도(skill)  +  0.50 × 검색 유사도(rag)  +  0.10 × 직무 행동어(verb)
//
//   ① 역량 일치도(40%): 직무의 핵심·우대 역량 사전과 내 문서를 대조. 가장 설명하기 쉽고 신뢰도가 높아 비중이 큼.
//      단, Git·SQL·Python처럼 여러 직무에 공통인 기술은 변별력이 낮으므로 "특이도(여러 직무에 흔할수록 낮은 가중치)"를 곱합니다.
//   ② 검색 유사도(50%): RAG 검색기가 내 문서를 질의로 삼아 직무 지식 청크와의 BM25(+임베딩) 유사도를 구한 값.
//      사전에 없는 표현(예: "고객 불만을 분석")이 직무 설명 문장과 겹치는 것을 보완합니다.
//   ③ 행동어(10%): 설계·분석·운영처럼 그 직무 업무를 나타내는 동사가 얼마나 나오는지.
//
//   [가중치를 이렇게 정한 과정 — 솔직하게]
//   처음엔 사전 일치(60%)를 가장 믿었으나, 기술명을 풀어 쓴 문서(samples/hard.json)에서는 사전이 거의 못 맞혔습니다(Top-1 30%).
//   검색(RAG)이 그 빈틈을 메운다는 것을 확인해(80%) 검색 비중을 높였습니다. 사전은 '설명 가능한 근거'로 여전히 중요합니다.
//   이 가중치는 같은 평가셋으로 골랐으므로 과적합 가능성이 있습니다(tools/eval.mjs 한계 참고).
// ─────────────────────────────────────────────────────────────────────────────
import { JOBS } from '../knowledge/jobs.mjs';
import { findSkills } from './profile.mjs';
import { normalize } from './text.mjs';

export const WEIGHTS = { skill: 0.40, rag: 0.50, verb: 0.10 };

// 같은 역량이 몇 개 직무에 쓰이는지 세어 "특이도"를 만듭니다. (한 번만 계산해 재사용)
//   특이도 = 1 / sqrt(그 역량을 쓰는 직무 수) → 모두가 쓰는 역량은 낮고, 한 직무에만 있으면 1
function buildSpecificity(jobs) {
  const used = new Map();
  for (const j of jobs) for (const s of new Set([...j.core, ...j.nice].map((x) => x.name))) used.set(s, (used.get(s) ?? 0) + 1);
  return (name) => 1 / Math.sqrt(used.get(name) ?? 1);
}

// docs: analyzeDocs 결과, retriever: Retriever, 반환: 적합도 내림차순 추천 목록
export async function recommendJobs(docs, retriever, { jobs = JOBS, top = 3 } = {}) {
  const spec = buildSpecificity(jobs);
  const text = docs.all;
  const nText = normalize(text);

  // ② 검색 유사도: 문서 전체를 질의로 직무 청크 전체(공통 가이드 제외)를 검색 → 직무별로 합산
  // 질의 길이를 제한하되, 이력서가 길어도 자소서가 통째로 잘려 나가지 않도록 각각 앞 2,000자씩 사용합니다.
  // (예전에는 합친 글의 앞 4,000자만 써서 이력서가 길면 자소서가 검색에 전혀 반영되지 않았습니다.)
  const ragQuery = `${docs.resume.slice(0, 2000)}
${docs.cover.slice(0, 2000)}`;
  const hits = await retriever.search(ragQuery, 80, (c) => c.jobId !== null);
  const ragSum = new Map(), ragBest = new Map();
  for (const h of hits) {
    ragSum.set(h.chunk.jobId, (ragSum.get(h.chunk.jobId) ?? 0) + h.fused);
    (ragBest.get(h.chunk.jobId) ?? ragBest.set(h.chunk.jobId, []).get(h.chunk.jobId)).push(h);
  }
  const maxRag = Math.max(...ragSum.values(), 1e-9); // 직무 간 상대 비교(최고 직무=1)

  const rows = jobs.map((job) => {
    // ① 역량 일치도 (특이도 가중)
    const coreFound = findSkills(text, job.core);
    const niceFound = findSkills(text, job.nice);
    const wTotal = job.core.reduce((s, x) => s + spec(x.name), 0) + 0.5 * job.nice.reduce((s, x) => s + spec(x.name), 0);
    const wHit = coreFound.reduce((s, x) => s + spec(x.name), 0) + 0.5 * niceFound.reduce((s, x) => s + spec(x.name), 0);
    // 핵심 역량 전부를 가진 사람은 드물므로, 절반(0.5)만 갖춰도 만점에 가깝게 보이도록 2배 후 상한 1로 보정
    const skill = Math.min(1, (wHit / wTotal) * 2);

    // ③ 행동어 비율
    const verbHit = job.verbs.filter((v) => nText.includes(v)).length;
    const verb = verbHit / job.verbs.length;

    const rag = (ragSum.get(job.id) ?? 0) / maxRag;
    const fit = WEIGHTS.skill * skill + WEIGHTS.rag * rag + WEIGHTS.verb * verb;

    const matchedNames = new Set(coreFound.map((x) => x.name));
    return {
      jobId: job.id, name: job.name, summary: job.summary,
      fit: Math.round(fit * 1000) / 10, // 0~100, 소수 1자리
      parts: { skill: round(skill), rag: round(rag), verb: round(verb) },
      coreMatched: coreFound, niceMatched: niceFound,
      coreMissing: job.core.filter((x) => !matchedNames.has(x.name)).map((x) => x.name),
      evidence: (ragBest.get(job.id) ?? []).slice(0, 2).map((h) => ({ id: h.chunk.id, title: h.chunk.title, text: h.chunk.text })),
    };
  });

  rows.sort((a, b) => b.fit - a.fit);
  const picked = rows.slice(0, top);
  picked.forEach((r, i) => { r.rank = i + 1; r.reasons = explain(r); });
  return { recommendations: picked, all: rows.map(({ jobId, name, fit }) => ({ jobId, name, fit })), confidence: confidence(rows) };
}

const round = (x) => Math.round(x * 100) / 100;

// 사람이 읽을 수 있는 추천 이유 문장(설명 가능한 AI: 왜 이 직무인지를 근거와 함께)
function explain(r) {
  const out = [];
  if (r.coreMatched.length) out.push(`핵심 역량 ${r.coreMatched.length}개 보유: ${r.coreMatched.map((x) => x.name).join(', ')}`);
  if (r.niceMatched.length) out.push(`우대 역량 ${r.niceMatched.length}개 보유: ${r.niceMatched.map((x) => x.name).join(', ')}`);
  if (r.parts.rag >= 0.6) out.push('문서 표현이 이 직무 설명과 유사하게 검색되었습니다.');
  if (!out.length) out.push('직접 일치하는 역량은 적지만 문서의 표현이 이 직무와 비교적 가깝습니다.');
  return out;
}

// 추천 신뢰도: 1위의 절대 점수와 2위와의 격차를 함께 봅니다.
//   - 점수 자체가 낮으면(문서에 직무 단서가 거의 없음) 추천을 믿기 어렵습니다.
//   - 1·2위가 비슷하면 "여러 직무에 걸쳐 있는 프로필"이므로 사용자가 직접 고르게 안내합니다.
function confidence(sorted) {
  const [a, b] = sorted;
  // 검색 점수(rag)는 "직무 간 상대값"이라 가장 높은 직무가 항상 1이 됩니다. 문서가 아무리 빈약해도 점수가 부풀 수 있으므로,
  // 절대적 단서인 "사전에서 실제로 찾은 역량 수"와 "행동어 비율"로 신뢰도를 한 번 더 점검합니다.
  const hits = a.coreMatched.length + a.niceMatched.length;
  const weakEvidence = hits < 2 && a.parts.verb < 0.2;
  const level = a.fit < 25 || weakEvidence ? 'low' : a.fit - (b?.fit ?? 0) < 3 ? 'medium' : 'high';
  const note = level === 'low'
    ? '문서에 직무를 판단할 단서가 부족합니다. 사용 기술·프로젝트·역할을 더 구체적으로 적어 보세요.'
    : level === 'medium'
      ? '상위 직무의 점수 차이가 작습니다. 두 직무 모두 검토해 보고 원하는 방향을 직접 선택하세요.'
      : '상위 직무가 비교적 뚜렷합니다.';
  return { level, note, top: a.fit, gap: Math.round((a.fit - (b?.fit ?? 0)) * 10) / 10 };
}
