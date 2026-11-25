// tools/llm_check.mjs — 실제 LLM(기본: 로컬 Ollama)으로 보완 제안을 돌려 "AI 제안 채택률"과 실패 사유를 보는 점검 스크립트
// 사용법: node tools/llm_check.mjs [P1,P3,P7]   (모의 지원자 ID, 기본 P1,P3,P7)
// 주의: 문장마다 모델을 호출하므로 느립니다(로컬 소형 모델은 문장당 수 초~수십 초). 결과는 모델·프롬프트 변경 전후 비교용이며
//       소수 문서의 관찰이므로 일반화하지 않습니다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, ROOT } from '../src/app.mjs';

const ids = (process.argv[2] ?? 'P1,P3,P7').split(',');
const app = await createApp({ dbFile: ':memory:', env: process.env });
console.log('LLM:', app.llm.label);
if (!app.llm.available) { console.log('사용 가능한 LLM이 없습니다(Ollama 실행 또는 API 키 필요).'); process.exit(0); }
const personas = JSON.parse(readFileSync(join(ROOT, 'samples', 'personas.json'), 'utf8')).filter((p) => ids.includes(p.id));
let total = 0, adopted = 0; const reasons = {};
for (const p of personas) {
  const uid = `llm-${p.id.toLowerCase()}-user`;
  const sub = await app.analyze(uid, p.resume, p.cover);
  const rv = await app.review(uid, sub.submissionId, p.intended[0] ?? 'backend');
  const t0 = Date.now();
  const out = await app.revise(uid, rv.reviewId, true);
  const n = out.suggestions.length, a = out.suggestions.filter((s) => s.method === 'llm').length;
  total += n; adopted += a;
  for (const s of out.suggestions) if (s.note) { const k = s.note.replace(/^.*\((.*)\)\.?$/u, '$1'); reasons[k] = (reasons[k] ?? 0) + 1; }
  console.log(`${p.id}: AI 채택 ${a}/${n} (${Math.round((Date.now() - t0) / 1000)}초)`);
  for (const s of out.suggestions.filter((x) => x.method === 'llm')) console.log('   ✔', s.original.slice(0, 40), '→', s.suggestion.slice(0, 80));
}
console.log(`합계 AI 채택 ${adopted}/${total}`, reasons);
