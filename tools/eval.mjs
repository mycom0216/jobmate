// ─────────────────────────────────────────────────────────────────────────────
// tools/eval.mjs — 직무 추천 정확도 평가 스크립트
//
// 사용법: node tools/eval.mjs            (LLM 없이 실행: 추천은 LLM을 쓰지 않으므로 결과가 항상 같음)
//
// [무엇을 재나]
//   samples/eval.json 의 가상 이력서·자소서 26건(직무당 2건)에 정답 직무(label)가 붙어 있습니다.
//   추천 결과의 Top-1(1순위가 정답) / Top-3(3순위 안에 정답) 비율과 오답 사례를 출력합니다.
//
// [정직한 한계 — 반드시 발표·면접에서 함께 말할 것]
//   1) 평가 문서는 작성자(본인)가 직접 쓴 "가상 데이터"이고 규모가 작습니다(26건).
//   2) 점수 가중치를 같은 평가셋에서 조정했기 때문에, 실제 사용자 문서에서는 정확도가 이보다 낮을 수 있습니다.
//   3) 따라서 이 수치는 "기능이 의도대로 동작하는지 확인하는 회귀 점검"이지 일반화 성능의 증거가 아닙니다.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, ROOT } from '../src/app.mjs';
import { analyzeDocs } from '../src/profile.mjs';
import { recommendJobs, WEIGHTS } from '../src/recommend.mjs';

const app = await createApp({ dbFile: ':memory:', env: { LLM_PROVIDER: 'off' } });
const load = (f) => JSON.parse(readFileSync(join(ROOT, 'samples', f), 'utf8'));

// 한 평가셋을 돌려 Top-1/Top-3 결과를 돌려줍니다.
async function run(set) {
  let top1 = 0, top3 = 0;
  const wrong = [];
  for (const s of set) {
    const docs = analyzeDocs({ resume: s.resume, cover: s.cover });
    const { recommendations } = await recommendJobs(docs, app.retriever, { top: 3 });
    const ids = recommendations.map((r) => r.jobId);
    if (ids[0] === s.label) top1++; else wrong.push({ label: s.label, got: ids, fit: recommendations.map((r) => r.fit) });
    if (ids.includes(s.label)) top3++;
  }
  return { n: set.length, top1, top3, wrong };
}
const pct = (a, n) => `${a}/${n} (${((a / n) * 100).toFixed(1)}%)`;

// 두 평가셋:
//  easy(26건) — 직무 사전과 비슷한 기술 용어를 쓴 문서 → 사전 일치 기능의 회귀 점검용
//  hard(10건) — 기술 용어를 풀어 쓴 일상어 문서 → 사전에 없는 표현에서 RAG 검색이 얼마나 보완하는지 확인용
const easy = load('eval.json'), hard = load('hard.json');

console.log(`검색 모드 ${app.retriever.mode} / 직무 13종\n`);
const full = { ...WEIGHTS };
const configs = [
  ['전체(역량 .40 + 검색 .50 + 행동어 .10)', full],
  ['역량 사전만(검색·행동어 제외)', { skill: 1, rag: 0, verb: 0 }],
  ['검색(RAG)만', { skill: 0, rag: 1, verb: 0 }],
];
for (const [name, w] of configs) {
  Object.assign(WEIGHTS, w); // 같은 코드·같은 데이터에서 가중치만 바꿔 각 신호의 기여를 비교(ablation)
  const e = await run(easy), h = await run(hard);
  console.log(`■ ${name}`);
  console.log(`   easy Top-1 ${pct(e.top1, e.n)}  Top-3 ${pct(e.top3, e.n)}`);
  console.log(`   hard Top-1 ${pct(h.top1, h.n)}  Top-3 ${pct(h.top3, h.n)}`);
  if (name.startsWith('전체')) {
    for (const x of e.wrong) console.log(`     [easy 오답] 정답=${x.label} → ${x.got.join(', ')} (${x.fit.join(', ')})`);
    for (const x of h.wrong) console.log(`     [hard 오답] 정답=${x.label} → ${x.got.join(', ')} (${x.fit.join(', ')})`);
  }
}
Object.assign(WEIGHTS, full);
