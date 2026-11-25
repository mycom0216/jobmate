// 설문 집계 스크립트(tools/analyze_survey.mjs) 테스트.
// 주의: 아래 CSV는 계산이 맞는지 확인하려는 "테스트용 가짜 데이터"이며 실제 평가 결과가 아닙니다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv, summarize } from '../tools/analyze_survey.mjs';

const CSV = [
  'rater,field,thinkJob,top1,top3,scoreBefore,scoreAfter,q2,q3,q4,q5,q6,q7,q8,q9,comment',
  'A,백엔드,backend,예,예,50,70,4,4,3,5,4,아니오,4,5,"버튼이 작아요, 그리고 느려요"',
  'B,마케팅,marketing,아니오,예,40,44,3,3,3,3,3,아니오,5,3,',
  'C,영업,sales,아니오,아니오,,,,2,,,,예,2,,',
].join('\n');

test('CSV 파서: 따옴표 안의 쉼표와 빈 칸을 올바르게 읽는다', () => {
  const rows = parseCsv(CSV);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].comment, '버튼이 작아요, 그리고 느려요');
  assert.equal(rows[2].scoreBefore, '');
});

test('집계: 빈 칸은 0점이 아니라 응답 없음으로 계산에서 제외한다', () => {
  const { metrics } = summarize(parseCsv(CSV));
  assert.equal(metrics.n, 3);
  assert.equal(metrics.top1, 33.3);          // 3명 중 1명
  assert.equal(metrics.top3, 66.7);          // 3명 중 2명
  assert.equal(metrics.usefulness, 3.4);     // q3: 4,3,2 + q5: 5,3 → (4+3+2+5+3)/5
  assert.equal(metrics.scoreDelta, 12);      // (+20, +4) 평균. C는 점수 없음 → 제외
  assert.equal(metrics.fabricated, 1);
  assert.equal(metrics.trust, 3.5);          // q6: 4,3
});

test('성공 기준 판정: 미달 항목을 숨기지 않고 응답 없는 지표는 판단 불가로 표시한다', () => {
  const { criteria } = summarize(parseCsv(CSV));
  const get = (k) => criteria.find((c) => c[0].includes(k));
  assert.equal(get('Top-3')[2], '달성');   // 66.7% ≥ 60
  assert.equal(get('유용성')[2], '미달');                           // 3.4 < 3.5
  assert.equal(get('Q7')[2], '미달');                               // 1건 ≥ 1
  assert.equal(get('신뢰성')[2], '달성');                           // 3.5 ≥ 3.5
  const empty = summarize(parseCsv('rater,top3\nA,\n'));
  assert.equal(empty.criteria.find((c) => c[0].includes('Top-3'))[2], '판단 불가(응답 없음)');
});

test('Q7에 응답이 하나도 없으면 "0건 달성"이 아니라 판단 불가로 표시한다', () => {
  const { criteria } = summarize(parseCsv('rater,q7\nA,\nB,\n'));
  assert.equal(criteria.find((c) => c[0].includes('Q7'))[2], '판단 불가(응답 없음)');
});
