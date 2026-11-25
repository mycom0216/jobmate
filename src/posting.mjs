// ─────────────────────────────────────────────────────────────────────────────
// posting.mjs — 채용 공고 기반 점검: "이 공고의 요건을 내 서류가 얼마나 충족하는가"
//
// [직무 점검(review.mjs)과 무엇이 다른가]
//   review.mjs는 "직무 일반 기준"(우리가 정리한 가이드)으로 서류의 작성 품질을 봅니다.
//   이 모듈은 "특정 회사의 실제 공고"를 기준으로 삼아, 공고의 자격요건·우대사항 한 줄 한 줄에 대해
//   내 서류에 그에 해당하는 내용이 있는지 확인합니다. (직무 지식이 예시 기준이라는 한계를 보완)
//
// [동작 방식 — 전부 규칙 기반, LLM·외부 전송 없음]
//   1) 공고 텍스트를 줄 단위로 나누고, "자격요건 / 우대사항 / 담당업무" 제목을 찾아 항목을 구분한다.
//   2) 항목마다 서류와 대조한다.
//        · 항목에 기술명(Java, SQL …)이 있으면 → 직무 사전(jobs.mjs)으로 서류에 그 기술이 있는지 확인
//        · 그 밖의 문장 항목은 → 글자 2개씩(바이그램) 겹침 비율이 가장 높은 서류 문장을 찾아 비교
//   3) 학력·경력 연차처럼 자동 판단이 위험한 조건은 "확인 필요/미충족 가능"으로만 표시한다.
//   4) 공고와 가장 가까운 직무를 추천 로직으로 찾아, 그 직무로 이어서 점검하도록 안내한다.
//
// [왜 "충족/미충족"을 단정하지 않고 '충족·부분·미확인'이라 부르나]
//   글자 겹침으로 의미를 완벽히 판단할 수 없습니다. 그래서 근거 문장을 함께 보여 주고 사용자가 최종 판단하게 합니다.
//   (미확인 = 서류에서 찾지 못함. 실제로는 경험이 있는데 안 썼을 수도 있으므로 "추가 기회"로 안내)
// ─────────────────────────────────────────────────────────────────────────────
import { JOBS } from '../knowledge/jobs.mjs';
import { findSkills } from './profile.mjs';
import { recommendJobs } from './recommend.mjs';
import { analyzeDocs } from './profile.mjs';
import { sentences, tokens } from './text.mjs';

// 모든 직무의 역량 목록(이름 기준 중복 제거). 공고 속 기술명을 찾는 사전으로 사용합니다.
const ALL_SKILLS = [...new Map(JOBS.flatMap((j) => [...j.core, ...j.nice]).map((s) => [s.name, s])).values()];

// 공고의 구간 제목을 알아보는 패턴. 제목은 짧은 줄이라는 점을 함께 이용해 본문 문장과 구분합니다.
const HEAD = {
  required: /(자격\s*요건|지원\s*자격|필수\s*(요건|사항|조건|역량)?|requirements?|qualifications?|must\s*have)/iu,
  preferred: /(우대\s*(사항|조건|역량)?|preferred|nice\s*to\s*have|plus)/iu,
  duty: /(담당\s*업무|주요\s*업무|하는\s*일|업무\s*내용|responsibilit\w*|what\s*you)/iu,
  other: /(복리\s*후생|혜택|전형|채용\s*절차|근무\s*조건|회사\s*소개|제출\s*서류|접수|지원\s*방법|기타)/iu,
};
const BULLET = /^[\s•\-*·▪■●○◦▶ㆍ\d.)\]]+/u;

// 공고를 {required, preferred, duty} 항목 배열로 나눕니다. 구간 제목이 하나도 없으면 전부 required로 간주(플래그 반환).
export function parsePosting(text) {
  const out = { required: [], preferred: [], duty: [], sectioned: false, title: null };
  let cur = null;
  const lines = String(text ?? '').split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
  out.title = lines[0] && lines[0].length <= 60 ? lines[0] : null;
  const loose = [];
  for (const raw of lines) {
    const body = raw.replace(BULLET, '').trim();
    const colon = /^([^:：]{1,20})[:：]\s*(.*)$/u.exec(body);
    const headText = colon ? colon[1] : body;
    const isHeadLine = headText.length <= 22 && !/[.다요함음]$/u.test(headText.replace(/[\]\)\s]+$/u, '')) || (colon && headText.length <= 12);
    let matched = null;
    if (isHeadLine) for (const k of ['preferred', 'required', 'duty', 'other']) if (HEAD[k].test(headText)) { matched = k; break; }
    if (matched) {
      cur = matched === 'other' ? null : matched; out.sectioned = true;
      const rest = colon?.[2]?.trim();
      if (cur && rest && rest.length >= 4) out[cur].push(rest);
      continue;
    }
    if (body.length < 4) continue;
    if (cur) out[cur].push(body); else loose.push(body);
  }
  if (!out.sectioned) out.required = loose; // 구분 불가 → 전부 필수로 간주
  return out;
}

// 학력·경력처럼 글자 겹침으로 판단하면 위험한 조건을 따로 뽑습니다.
function hardConditions(postingText, resumeText) {
  const out = [];
  const eduReq = /(학사|대졸|4년제|대학교?\s*졸업|석사|박사|전문학사|전문대)[^\n]{0,12}(이상|졸업|필수)?/u.exec(postingText);
  if (eduReq) {
    const hasUniv = /(대학교|대학원|전문대|학사|석사|박사)/u.test(resumeText);
    out.push({ type: '학력', text: eduReq[0].trim(), status: hasUniv ? 'check' : 'likely-unmet',
      note: hasUniv ? '서류의 학력과 공고 요건을 직접 대조하세요.' : '서류에 대학 학력이 보이지 않아 학력 요건을 충족하지 못할 수 있습니다. 공고에 "학력 무관"이나 대체 요건이 있는지 확인하세요.' });
  }
  const yrs = /경력\s*(\d+)\s*년\s*(이상|이하)?/u.exec(postingText);
  if (yrs) out.push({ type: '경력', text: yrs[0].trim(), status: 'check', note: '관련 직무 경력 연차는 자동으로 계산하지 않습니다. 본인의 해당 직무 경력과 직접 대조하세요.' });
  if (/신입/u.test(postingText) && !yrs) out.push({ type: '경력', text: '신입 지원 가능', status: 'ok', note: '신입이 지원 가능한 공고로 보입니다.' });
  if (/(병역|군필)/u.test(postingText)) out.push({ type: '병역', text: '병역 관련 문구', status: 'check', note: '병역 요건 문구가 있습니다. 공고를 직접 확인하세요.' });
  return out;
}

// 어간(w:)과 바이그램(b:)을 모두 비교 대상으로 씁니다. 바이그램만 쓰면 "API" 같은 짧은 영문 단어가 약해지기 때문입니다.
const bigrams = (s) => new Set(tokens(s).filter((t) => t[0] === 'b' || t[0] === 'w'));

// 항목 하나를 서류와 대조합니다. 반환: { text, kind, status, evidence, skills }
function matchItem(text, kind, docSents, allDocText) {
  // 같은 별칭을 여러 역량이 공유하면(예: 'sql'은 SQL의 이름이면서 '데이터 기반 의사결정'의 별칭) 공고 항목이 엉뚱한 역량으로
  // 해석됩니다. 그래서 어떤 역량이 "다른 역량의 이름"과 같은 별칭으로만 잡혔다면 그 역량은 버리고 이름이 일치하는 쪽만 씁니다.
  const hits = findSkills(text, ALL_SKILLS);
  const names = new Set(hits.map((s) => s.name.toLowerCase()));
  const skills = hits.filter((s) => s.matchedAs === s.name.toLowerCase() || !names.has(s.matchedAs)).map((s) => s.name);
  if (skills.length) {
    const found = new Set(findSkills(allDocText, ALL_SKILLS).map((s) => s.name));
    const have = skills.filter((n) => found.has(n));
    const status = have.length === skills.length ? 'met' : have.length ? 'partial' : 'missing';
    const quote = have.length ? docSents.find((s) => findSkills(s, ALL_SKILLS).some((x) => have.includes(x.name))) ?? null : null;
    return { text, kind, status, evidence: quote && quote.length > 110 ? quote.slice(0, 107) + '…' : quote, skills: skills.map((n) => ({ name: n, found: found.has(n) })) };
  }
  // 기술명이 없는 문장 항목: 바이그램 겹침이 가장 큰 서류 문장을 근거로 삼습니다.
  const q = bigrams(text);
  if (q.size < 3) return { text, kind, status: 'unknown', evidence: null, skills: [] };
  let best = { score: 0, sent: null };
  for (const s of docSents) {
    const b = bigrams(s); let hit = 0;
    for (const t of q) if (b.has(t)) hit++;
    const score = hit / q.size;
    if (score > best.score) best = { score, sent: s };
  }
  const status = best.score >= 0.5 ? 'met' : best.score >= 0.3 ? 'partial' : 'missing';
  return { text, kind, status, evidence: best.score >= 0.3 ? (best.sent.length > 110 ? best.sent.slice(0, 107) + '…' : best.sent) : null, skills: [] };
}

const rate = (items) => {
  const scored = items.filter((i) => i.status !== 'unknown');
  return scored.length ? Math.round((scored.reduce((s, i) => s + (i.status === 'met' ? 1 : i.status === 'partial' ? 0.5 : 0), 0) / scored.length) * 100) : null;
};

// 메인: docs(analyzeDocs 결과), postingText, retriever
export async function checkPosting(docs, postingText, retriever) {
  const parsed = parsePosting(postingText);
  const docSents = sentences(docs.all);
  // 학력·경력 연차 문장은 글자 겹침으로 판단하면 위험하므로 요건 목록에서 빼고, 아래 hardConditions에서 따로 안내합니다.
  const HARD_LINE = /(학사|대졸|4년제|전문학사|석사|박사|학력|경력\s*\d+\s*년|병역|군필|신입)/u;
  const mk = (arr, kind) => arr.filter((t) => !HARD_LINE.test(t)).slice(0, 25).map((t) => matchItem(t, kind, docSents, docs.all));
  const required = mk(parsed.required, 'required');
  const preferred = mk(parsed.preferred, 'preferred');
  const duty = mk(parsed.duty, 'duty');

  // 공고와 가까운 직무: 공고 텍스트를 서류처럼 분석해 같은 추천 로직에 넣습니다.
  const rec = await recommendJobs(analyzeDocs({ resume: postingText, cover: '' }), retriever, { top: 1 });
  const jobGuess = { jobId: rec.recommendations[0].jobId, name: rec.recommendations[0].name, fit: rec.recommendations[0].fit };

  // 공고가 요구하는데 서류에 없는 기술(필수·우대 항목에서만)
  const missingSkills = [...new Set([...required, ...preferred].flatMap((i) => i.skills.filter((s) => !s.found).map((s) => s.name)))];
  const conditions = hardConditions(postingText, docs.resume);
  const reqRate = rate(required), prefRate = rate(preferred);

  const advice = [];
  if (!parsed.sectioned) advice.push('공고에서 "자격요건/우대사항" 제목을 찾지 못해 모든 줄을 필수 요건으로 간주했습니다. 구분이 있다면 제목과 함께 붙여 넣으면 더 정확합니다.');
  if (missingSkills.length) advice.push(`공고가 요구하지만 서류에 보이지 않는 기술: ${missingSkills.join(', ')}. 실제로 사용한 경험이 있을 때만 사용 맥락과 함께 추가하세요(없는 경험을 만들어 쓰지 마세요).`);
  const miss = required.filter((i) => i.status === 'missing').length;
  if (miss) advice.push(`필수 요건 ${miss}개가 서류에서 확인되지 않습니다. 해당 경험이 있다면 구체적 문장과 수치로 보강하고, 없다면 학습 계획이나 관련 프로젝트로 정직하게 보완하세요.`);
  if (conditions.some((c) => c.status === 'likely-unmet')) advice.push('학력 등 자동 보완이 불가능한 조건이 있습니다. 서류 문장으로 해결되지 않으니 공고의 지원 자격(학력 무관 여부)을 먼저 확인하세요.');
  if (!advice.length) advice.push('공고 요건이 서류에 비교적 잘 드러납니다. 요건별 근거 문장에 수치와 결과를 보강해 보세요.');

  return {
    title: parsed.title, sectioned: parsed.sectioned, jobGuess,
    rates: { required: reqRate, preferred: prefRate },
    required, preferred, duty, conditions, missingSkills, advice,
    note: '글자 겹침으로 판단한 참고용 결과입니다. 근거 문장을 보고 최종 판단은 직접 하세요.',
  };
}
