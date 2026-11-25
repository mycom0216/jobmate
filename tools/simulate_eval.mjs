// ─────────────────────────────────────────────────────────────────────────────
// tools/simulate_eval.mjs — "모의 사용자" 평가 스크립트 (실제 사용자 평가가 아님!)
//
// 사용법: node tools/simulate_eval.mjs [--md]       (--md: 마크다운 표로 출력)
//
// [이것이 무엇이고 무엇이 아닌가 — 반드시 구분해서 말할 것]
//   samples/personas.json 의 가상 지원자 6명(작성자가 만든 문서)을 실제 프로그램 경로(analyze→review→revise→posting)에
//   그대로 통과시키고, "사람의 주관 평가 없이" 측정 가능한 것만 기록합니다.
//     · 추천 일치(Top-1/Top-3)  · 점검 점수 수정 전→후  · 보완 제안의 날조(새 숫자·새 기술) 여부
//     · 공고 충족도 수정 전→후  · 처리 시간
//   설문 점수(유용했나, 믿을 만했나 등)는 사람만 줄 수 있으므로 만들지 않습니다(조작 방지).
//   "수정 후" 문서는 작성자가 직접 "피드백을 반영해 고친 척" 쓴 것이라, 점수 상승은 도구의 효과 증명이 아니라
//   "개선한 문서를 도구가 더 높게 평가하는가(방향성)"를 확인하는 용도입니다.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, ROOT } from '../src/app.mjs';
import { validateRewrite } from '../src/revise.mjs';

const app = await createApp({ dbFile: ':memory:', env: { LLM_PROVIDER: 'off' } });
const personas = JSON.parse(readFileSync(join(ROOT, 'samples', 'personas.json'), 'utf8'));
const rows = [];

for (const p of personas) {
  const uid = `sim-${p.id.toLowerCase()}-user`;
  const t0 = performance.now();
  const a = await app.analyze(uid, p.resume, p.cover);
  const top = a.recommendations.map((r) => r.jobId);
  const hit1 = p.intended.includes(top[0]);
  const hit1ok = hit1 || p.alsoOk.includes(top[0]);
  const hit3 = top.some((j) => p.intended.includes(j));
  const jobId = p.intended[0]; // 점검은 의도한 직무 기준으로(사용자가 목표 직무를 직접 고르는 상황)
  const before = await app.review(uid, a.submissionId, jobId);
  const rev = await app.revise(uid, before.reviewId, false);
  // 날조 검사: 규칙 보완 제안이 원문에 없는 숫자·기술을 포함하지 않는가
  const fabricated = rev.suggestions.filter((s) => validateRewrite(s.suggestion, s.original, `${p.resume}\n${p.cover}`) !== null).length;
  const post = await app.posting(uid, a.submissionId, p.posting);
  const ms = Math.round(performance.now() - t0);

  const a2 = await app.analyze(uid, p.resumeAfter, p.coverAfter);
  const after = await app.review(uid, a2.submissionId, jobId);
  const post2 = await app.posting(uid, a2.submissionId, p.posting);

  rows.push({
    id: p.id, name: p.name, intended: p.intended[0], top, hit1, hit1ok, hit3, confidence: a.confidence.level,
    scoreBefore: before.score, scoreAfter: after.score,
    weakBefore: before.items.filter((i) => i.severity === 'high').map((i) => i.id),
    suggestions: rev.suggestions.length, fabricated,
    postBefore: post.rates.required, postAfter: post2.rates.required, prefBefore: post.rates.preferred, prefAfter: post2.rates.preferred,
    postJob: post.jobGuess.jobId, postCond: post.conditions.map((c) => `${c.type}:${c.status}`).join(','), ms,
  });
}

const n = rows.length, sum = (f) => rows.reduce((s, r) => s + f(r), 0);
const avg = (f) => Math.round((sum(f) / n) * 10) / 10;
if (process.argv.includes('--md')) {
  console.log('| ID | 지원자 | 의도 직무 | 추천 Top3 | 1순위 일치 | Top3 포함 | 신뢰도 | 점검 전→후 | 공고 필수충족 전→후 | 보완 제안(날조) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.id} | ${r.name} | ${r.intended} | ${r.top.join(', ')} | ${r.hit1 ? '일치' : r.hit1ok ? '허용 직무' : '불일치'} | ${r.hit3 ? 'O' : 'X'} | ${r.confidence} | ${r.scoreBefore}→${r.scoreAfter} | ${r.postBefore}%→${r.postAfter}% | ${r.suggestions}건(${r.fabricated}) |`);
} else console.table(rows.map(({ weakBefore, ...r }) => ({ ...r, top: r.top.join('/') })));
console.log(`\n요약: 1순위 일치 ${rows.filter((r) => r.hit1).length}/${n} (허용 직무 포함 ${rows.filter((r) => r.hit1ok).length}/${n}), Top-3 포함 ${rows.filter((r) => r.hit3).length}/${n}`);
console.log(`점검 점수 평균 ${avg((r) => r.scoreBefore)} → ${avg((r) => r.scoreAfter)} (평균 +${avg((r) => r.scoreAfter - r.scoreBefore)}), 모든 지원자 상승: ${rows.every((r) => r.scoreAfter > r.scoreBefore)}`);
console.log(`공고 필수 충족도 평균 ${avg((r) => r.postBefore ?? 0)}% → ${avg((r) => r.postAfter ?? 0)}%`);
console.log(`보완 제안 ${sum((r) => r.suggestions)}건 중 날조 ${sum((r) => r.fabricated)}건, 처리 시간 평균 ${avg((r) => r.ms)}ms`);
