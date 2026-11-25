// ─────────────────────────────────────────────────────────────────────────────
// review.mjs — 직무 적합 점검: "이 이력서·자소서가 선택한 직무에 맞게 쓰였는가"
//
// [동작 방식]
//   8가지 점검 항목을 각각 점수화(합계 100점)하고, 문제가 있으면
//     ① 문제가 된 원문 문장(증거)  ② 고치는 방법(조언)  ③ RAG가 찾은 근거 가이드(출처)
//   를 함께 돌려줍니다. "점수만 던지는" 시스템은 신뢰받기 어렵기 때문에 근거를 항상 붙입니다.
//
// [항목과 배점 — 왜 이 배점인가]
//   직무 역량 반영 20 · 정량 성과 20 · STAR 구조 15 · 직무 연결 10 · 주도성 10 · 상투 표현 10 · 이력서 구성 10 · 분량 5
//   채용담당자가 서류에서 가장 많이 보는 "직무 관련 역량"과 "성과 증거"에 가장 큰 비중을 두었습니다.
//   (배점은 작성자의 판단이며 절대적 기준이 아님 → 결과보고서의 한계에 명시)
// ─────────────────────────────────────────────────────────────────────────────
import { findSkills } from './profile.mjs';
import { normalize } from './text.mjs';
import { jobById } from './kb.mjs';

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const sev = (ratio) => (ratio >= 0.8 ? 'ok' : ratio >= 0.5 ? 'mid' : 'high'); // 득점률 → 심각도
const clip = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// 점검 항목 한 개를 만드는 도우미: got/max 로 점수와 심각도를 일관되게 계산합니다.
function item(id, title, max, ratio, detail, advice, evidence = [], queryHint = '') {
  const r = clamp(ratio);
  return { id, title, max, got: Math.round(max * r * 10) / 10, severity: sev(r), detail, advice, evidence, queryHint };
}

// 메인: docs(analyzeDocs 결과), jobId(점검 기준 직무), retriever(RAG 검색기)
export async function reviewDocs(docs, jobId, retriever) {
  const job = jobById(jobId);
  if (!job) throw new Error('알 수 없는 직무입니다.');
  const items = [];

  // 1) 직무 핵심 역량 반영 (20점) ─ 직무 사전의 core 목록 중 문서에 나타난 비율
  //    60%만 갖춰도 만점: 모든 기술을 다 가진 지원자는 거의 없고, 공고도 보통 일부만 요구하기 때문입니다.
  const core = findSkills(docs.all, job.core);
  const nice = findSkills(docs.all, job.nice);
  const coreRatio = core.length / job.core.length;
  const matched = new Set(core.map((x) => x.name));
  const missing = job.core.filter((x) => !matched.has(x.name)).map((x) => x.name);
  items.push(item('skills', '직무 핵심 역량 반영', 20, coreRatio / 0.6,
    `${job.name} 핵심 역량 ${job.core.length}개 중 ${core.length}개가 문서에 나타납니다${nice.length ? ` (우대 역량 ${nice.length}개 추가 확인)` : ''}.`,
    missing.length
      ? `아직 드러나지 않은 역량: ${missing.slice(0, 5).join(', ')}. 실제로 경험이 있다면 프로젝트·활동 안에 사용 맥락과 함께 적고, 경험이 없다면 학습 중인 내용이나 계획으로 정직하게 표현하세요(없는 경험을 만들어 쓰지 마세요).`
      : '핵심 역량이 고르게 드러납니다. 각 역량을 어떤 일에 썼는지 한 줄씩 덧붙이면 더 좋습니다.',
    core.slice(0, 3).map((x) => x.quote).filter(Boolean).map((q) => clip(q)), `${job.name} 이력서 핵심 역량 기술`));

  // 2) 정량 성과 (20점) ─ 숫자+단위가 들어간 문장 수. 4개 이상이면 만점.
  const q = docs.quantified.length;
  items.push(item('quant', '정량적 성과 표현', 20, q / 4,
    `숫자·단위로 성과를 보여 주는 문장이 ${q}개입니다(권장 4개 이상).`,
    q >= 4 ? '성과 수치가 충분합니다. 가능하면 "전 → 후" 비교로 변화를 보여 주세요.' : '프로젝트·활동마다 건수, 비율, 기간, 인원, 시간 단축 같은 수치를 한 가지 이상 넣으세요. 정확한 수치를 모르면 사실에 가까운 범위로 쓰되 지어내지 마세요.',
    docs.quantified.slice(0, 2).map((s) => clip(s)), '성과 수치 숫자 정량 결과'));

  // 3) 상투적·막연한 표현 (10점) ─ 숫자 없이 "열심히/최선" 등만 있는 문장 수
  const w = docs.weak.length;
  items.push(item('weak', '막연·상투적 표현', 10, 1 - w / 4,
    w ? `구체적 근거 없이 의지·성격만 말하는 문장이 ${w}개 있습니다.` : '막연한 표현이 거의 없습니다.',
    w ? '이런 문장은 빼거나, 그 성격을 보여 주는 실제 행동과 결과 한 가지로 바꾸세요. 예: "성실하다" → "6개월간 주 3회 스터디를 빠짐없이 운영했다".' : '현재 수준을 유지하세요.',
    docs.weak.slice(0, 3).map((x) => `${clip(x.sentence)}  (${x.phrases.join(', ')})`), '상투적 표현 열심히 최선 성실'));

  // 4) STAR 구조 (15점) ─ 자소서에 상황·과제·행동·결과 단서가 몇 종류 있는가
  if (!docs.coverLen) {
    items.push(item('star', '경험 서술 구조(STAR)', 15, 0, '자기소개서가 비어 있어 점검할 수 없습니다.', '자기소개서를 입력하면 상황-과제-행동-결과 구조까지 점검해 드립니다.', [], 'STAR 상황 과제 행동 결과'));
  } else {
    const present = Object.entries(docs.star).filter(([, n]) => n > 0).map(([k]) => k);
    const lack = ['situation', 'task', 'action', 'result'].filter((k) => !present.includes(k));
    const KO = { situation: '상황', task: '과제·역할', action: '행동', result: '결과' };
    items.push(item('star', '경험 서술 구조(STAR)', 15, present.length / 4,
      `상황·과제·행동·결과 중 ${present.length}/4 요소가 보입니다${lack.length ? ` (부족: ${lack.map((k) => KO[k]).join(', ')})` : ''}.`,
      lack.length ? `${lack.map((k) => KO[k]).join('·')} 부분을 보강하세요. 특히 결과가 빠지면 "그래서 무엇이 달라졌는지"가 전달되지 않습니다.` : '경험 서술의 흐름이 갖춰져 있습니다.',
      [], 'STAR 상황 행동 결과 구조 경험 서술'));
  }

  // 5) 직무 연결 (10점) ─ 자소서가 직무 핵심 역량·직무 관련 동기를 언급하는가
  if (!docs.coverLen) {
    items.push(item('link', '직무 연결성', 10, 0, '자기소개서가 비어 있어 점검할 수 없습니다.', '경험이 지원 직무의 어떤 업무로 이어지는지 한 문장으로 연결해 쓰세요.', [], '직무 연결 지원 동기'));
  } else {
    const coverCore = findSkills(docs.cover, job.core).length;
    const nCover = normalize(docs.cover);
    const motive = ['지원', '동기', '입사', '직무', job.name.split(/[·(]/u)[0].toLowerCase()].some((k) => nCover.includes(k));
    const ratio = clamp(coverCore / 2) * 0.7 + (motive ? 0.3 : 0);
    items.push(item('link', '직무 연결성', 10, ratio,
      `자기소개서에서 ${job.name} 핵심 역량이 ${coverCore}개 언급되고, 지원 동기/직무 언급은 ${motive ? '있습니다' : '없습니다'}.`,
      ratio >= 0.8 ? '직무와의 연결이 분명합니다.' : `경험에서 얻은 역량이 ${job.name} 업무(${job.verbs.slice(0, 3).join('·')} 등)에 어떻게 쓰이는지 한 문장으로 이어 쓰세요.`,
      [], '직무 연결 지원 동기 역량'));
  }

  // 6) 주도성 (10점) ─ "구현·설계" 같은 주도 표현 vs "참여·도왔다" 같은 소극 표현
  const act = docs.active, pas = docs.passive;
  const initiative = act + pas === 0 ? 0.3 : act / (act + pas * 1.5);
  items.push(item('initiative', '주도성(내가 한 일)', 10, initiative * 1.1,
    `주도·기여 표현 ${act}개, 소극적 참여 표현 ${pas}개가 발견됩니다.`,
    initiative >= 0.8 ? '본인의 역할이 잘 드러납니다.' : '"참여했습니다/도왔습니다"를 "제가 ○○를 설계·구현했습니다"처럼 본인이 한 일 중심으로 바꾸세요. 팀 결과는 팀 목표와 내 기여를 나누어 쓰세요.',
    [], '내가 한 일 팀 프로젝트 역할 기여'));

  // 7) 이력서 구성 (10점) ─ 연락처·학력·경력/프로젝트·기술·자격/수상 5항목
  if (!docs.resumeLen) {
    items.push(item('structure', '이력서 필수 구성', 10, 0, '이력서가 비어 있어 점검할 수 없습니다.', '인적사항, 학력, 경력/프로젝트, 보유 기술, 자격·수상을 갖춰 작성하세요.', [], '이력서 구성 필수 항목'));
  } else {
    const KO = { contact: '연락처', education: '학력', experience: '경력·프로젝트', skills: '보유 기술', certs: '자격·수상' };
    const miss = Object.keys(KO).filter((k) => !docs.sections[k]);
    items.push(item('structure', '이력서 필수 구성', 10, (5 - miss.length) / 5,
      miss.length ? `빠진 항목: ${miss.map((k) => KO[k]).join(', ')}.` : '필수 항목이 모두 있습니다.',
      miss.length ? `${miss.map((k) => KO[k]).join(', ')} 항목을 추가하세요. 해당 사항이 없다면 "없음"이라도 표기하면 누락으로 오해받지 않습니다.` : '구성이 완성돼 있습니다.',
      [], '이력서 구성 필수 항목 학력 경력'));
  }

  // 8) 분량 (5점) ─ 이력서 400자 이상, 자소서 500~3500자(공백 제외)
  const rOk = docs.resumeLen >= 400, cOk = docs.coverLen >= 500 && docs.coverLen <= 3500;
  items.push(item('length', '분량', 5, (rOk ? 0.5 : clamp(docs.resumeLen / 400) * 0.5) + (cOk ? 0.5 : docs.coverLen > 3500 ? 0.3 : clamp(docs.coverLen / 500) * 0.5),
    `이력서 ${docs.resumeLen}자, 자기소개서 ${docs.coverLen}자(공백 제외).`,
    (rOk && cOk) ? '분량이 적절합니다.' : `${!rOk ? '이력서는 400자 이상으로 경험을 구체화하세요. ' : ''}${docs.coverLen < 500 ? '자기소개서는 500자 이상으로 근거 사례를 보강하세요.' : docs.coverLen > 3500 ? '자기소개서가 너무 깁니다. 핵심 사례 중심으로 줄이세요.' : ''}`.trim(),
    [], '분량 문단 구성'));

  // ── RAG: 항목마다 "근거 가이드"를 검색해 붙입니다 ─────────────────────
  // 질의 = 항목 키워드 + 문제가 된 원문 → 지원 직무 청크와 공통 가이드 청크 중에서만 검색.
  // 이렇게 하면 같은 항목이라도 지원 직무·사용자 문장에 따라 근거가 달라질 수 있습니다.
  for (const it of items) {
    const query = `${it.queryHint} ${it.evidence.join(' ')}`;
    const [hit] = await retriever.search(query, 1, (c) => c.jobId === jobId || c.jobId === null);
    it.guide = hit ? { id: hit.chunk.id, title: hit.chunk.title, text: hit.chunk.text } : null;
    delete it.queryHint;
  }

  const max = items.reduce((s, x) => s + x.max, 0), got = items.reduce((s, x) => s + x.got, 0);
  const score = Math.round((got / max) * 100);
  const order = { high: 0, mid: 1, ok: 2 };
  const toFix = items.filter((x) => x.severity !== 'ok').sort((a, b) => order[a.severity] - order[b.severity] || (b.max - b.got) - (a.max - a.got));

  return {
    jobId, jobName: job.name, score,
    grade: score >= 80 ? '양호' : score >= 60 ? '보완 필요' : '대폭 보완 필요',
    items,
    strengths: items.filter((x) => x.severity === 'ok').map((x) => x.title),
    toFix: toFix.map((x) => x.id),
    example: job.example,
  };
}
