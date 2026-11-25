// ─────────────────────────────────────────────────────────────────────────────
// tools/analyze_survey.mjs — 실제 사용자 평가 응답(CSV)을 집계해 성공 기준과 비교하는 스크립트
//
// 사용법: node tools/analyze_survey.mjs 응답파일.csv        (양식: samples/survey_template.csv)
//
// [왜 스크립트로 만들었나]
//   평가 결과를 손으로 계산하면 실수하거나, 기준에 못 미치는 지표를 무심코 빼 버릴 수 있습니다.
//   정해 둔 기준(사용자평가계획 6장)대로 자동 집계해, 미달 항목도 그대로 드러나게 하려는 목적입니다.
//
// [입력 형식 — 한 줄이 평가자 한 명]
//   rater, field, thinkJob, top1, top3, scoreBefore, scoreAfter, q2, q3, q4, q5, q6, q7, q8, q9, comment
//   · top1 / top3 : 예 또는 아니오 (추천 1순위가 본인 생각과 같은가 / Top 3 안에 있는가)
//   · q2~q6, q8, q9 : 1~5 점,  q7 : 예(사실과 다른 내용이 있었다) 또는 아니오
//   · 빈 칸은 "응답 없음"으로 보고 해당 지표 계산에서만 뺍니다(0점으로 취급하지 않음).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';

// 따옴표("...")로 감싼 값 안의 쉼표를 지키는 최소 CSV 파서. 외부 라이브러리 없이 필요한 만큼만 구현.
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', quoted = false;
  const s = String(text).replace(/^﻿/u, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((v) => v.trim() !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((v) => v.trim() !== '')) rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const num = (v) => { const n = Number(v); return v !== '' && Number.isFinite(n) ? n : null; };
const yes = (v) => (/^(예|네|y|yes|o)$/iu.test(v) ? true : /^(아니오|아니요|n|no|x)$/iu.test(v) ? false : null);
const avg = (xs) => { const a = xs.filter((x) => x !== null); return a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 100) / 100 : null; };
const ratio = (xs) => { const a = xs.filter((x) => x !== null); return a.length ? Math.round((a.filter(Boolean).length / a.length) * 1000) / 10 : null; };

// 성공 기준(사용자평가계획 6장): 값이 null(응답 없음)이면 "판단 불가"로 표시
export function summarize(rows) {
  const col = (k, f) => rows.map((r) => f(r[k] ?? ''));
  const diff = rows.map((r) => (num(r.scoreBefore ?? '') !== null && num(r.scoreAfter ?? '') !== null ? num(r.scoreAfter) - num(r.scoreBefore) : null));
  const m = {
    n: rows.length,
    q7answered: col('q7', yes).filter((v) => v !== null).length,
    top1: ratio(col('top1', yes)), top3: ratio(col('top3', yes)),
    usefulness: avg([...col('q3', num), ...col('q5', num)]),
    trust: avg(col('q6', num)), fabricated: col('q7', yes).filter((v) => v === true).length,
    usability: avg(col('q8', num)), scoreDelta: avg(diff),
    q2: avg(col('q2', num)), q4: avg(col('q4', num)), q9: avg(col('q9', num)),
  };
  const judge = (v, ok) => (v === null ? '판단 불가(응답 없음)' : ok(v) ? '달성' : '미달');
  const criteria = [
    ['Top-3 포함 비율 ≥ 60%', m.top3 === null ? null : `${m.top3}%`, judge(m.top3, (v) => v >= 60)],
    ['유용성(Q3·Q5 평균) ≥ 3.5', m.usefulness, judge(m.usefulness, (v) => v >= 3.5)],
    ['신뢰성(Q6 평균) ≥ 3.5', m.trust, judge(m.trust, (v) => v >= 3.5)],
    // Q7에 한 명도 답하지 않았다면 "0건"이 아니라 "판단 불가"입니다(응답 없음을 '문제 없음'으로 오해하지 않도록).
    ['사실과 다른 제안(Q7 "예") = 0건', m.q7answered ? `${m.fabricated}건` : null, !m.q7answered ? '판단 불가(응답 없음)' : m.fabricated === 0 ? '달성' : '미달'],
    ['사용성(Q8 평균) ≥ 3.5', m.usability, judge(m.usability, (v) => v >= 3.5)],
    ['점검 점수 변화 평균 ≥ +5점', m.scoreDelta, judge(m.scoreDelta, (v) => v >= 5)],
  ];
  return { metrics: m, criteria };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/gu, '/')}` || process.argv[1]?.endsWith('analyze_survey.mjs')) {
  const file = process.argv[2];
  if (!file) { console.error('사용법: node tools/analyze_survey.mjs 응답파일.csv'); process.exit(1); }
  const rows = parseCsv(readFileSync(file, 'utf8'));
  const { metrics, criteria } = summarize(rows);
  console.log(`평가자 ${metrics.n}명`);
  console.log(`Top-1 일치 ${metrics.top1 ?? '-'}% · Top-3 포함 ${metrics.top3 ?? '-'}% · 추천 이유 이해(Q2) ${metrics.q2 ?? '-'} · 점수 체감(Q4) ${metrics.q4 ?? '-'} · 재사용 의향(Q9) ${metrics.q9 ?? '-'}\n`);
  for (const [name, value, verdict] of criteria) console.log(`${verdict.padEnd(10)} ${name}  →  ${value ?? '-'}`);
  console.log('\n※ 표본이 적어 통계적 일반화는 불가능합니다. 미달 항목도 결과보고서에 그대로 기록하고 원인·개선 계획을 쓰세요.');
  const comments = rows.filter((r) => r.comment).map((r) => `- ${r.rater}: ${r.comment}`);
  if (comments.length) console.log('\n불편·요청 의견:\n' + comments.join('\n'));
}
