// ─────────────────────────────────────────────────────────────────────────────
// profile.mjs — 사용자가 쓴 이력서·자기소개서에서 "특징(feature)"을 뽑아내는 분석기
//
// [무엇을 뽑나]
//   ① 기술·역량 키워드(직무 사전과 대조)  ② 정량 성과 문장(숫자+단위)  ③ 상투적·막연한 표현
//   ④ 주도성(내가 한 일 vs 참여만 한 일)   ⑤ STAR 구조 단서  ⑥ 이력서 필수 항목 유무
//
// [왜 이걸 LLM이 아니라 규칙(정규식·사전)으로 하나? — 면접 단골 질문]
//   - 재현성: 같은 입력 → 항상 같은 결과. 점검 결과를 설명·테스트할 수 있습니다.
//   - 비용·속도·개인정보: 외부 API 호출 없이 즉시, 내 PC 안에서 처리됩니다.
//   - 환각 방지: "있는 사실"만 뽑으니 지어낼 수 없습니다.
//   LLM은 "문장을 다시 쓰는 일"처럼 규칙으로 어려운 부분(revise.mjs)에만 보조로 씁니다.
// ─────────────────────────────────────────────────────────────────────────────
import { normalize, sentences } from './text.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// 별칭(alias) 하나가 텍스트에 있는지 검사합니다.
//  - 영문/숫자로만 된 별칭("java")은 앞뒤가 영문·숫자가 아닐 때만 일치로 봅니다.
//    왜? "java"가 "javascript" 안에서 잘못 잡히는 것을 막기 위해서입니다(경계 검사).
//  - 한글이 섞인 별칭("스프링")은 단순 포함 검사입니다. 한글은 조사가 붙어도("스프링을") 일치해야 하므로 경계 검사를 하지 않습니다.
const re = new Map(); // 정규식 캐시: 같은 별칭을 반복 컴파일하지 않으려는 성능 목적
export function hasAlias(normText, alias) {
  if (/[가-힣]/u.test(alias)) return normText.includes(alias);
  let r = re.get(alias);
  if (!r) { r = new RegExp(`(?<![a-z0-9])${esc(alias)}(?![a-z0-9])`, 'u'); re.set(alias, r); }
  return r.test(normText);
}

// 직무의 역량 목록(core/nice) 중 텍스트에서 발견된 것과 근거 문장을 돌려줍니다.
export function findSkills(text, list) {
  const norm = normalize(text);
  const sents = sentences(text);
  const found = [];
  for (const skill of list) {
    const alias = skill.aliases.find((a) => hasAlias(norm, a));
    if (!alias) continue;
    // 사용자에게 "이 문장에서 찾았다"를 보여 주기 위한 근거 문장(투명성)
    const quote = sents.find((s) => hasAlias(normalize(s), alias)) ?? null;
    found.push({ name: skill.name, matchedAs: alias, quote: quote && quote.length > 120 ? quote.slice(0, 117) + '…' : quote });
  }
  return found;
}

// 숫자+단위(성과 수치) 패턴. 단순 숫자(연도·번호)는 제외하려고 반드시 단위가 붙은 것만 봅니다.
// 주의: '개월·달'은 단위 목록에서 뺐습니다. "5개월 수료", "3년 근무"처럼 "기간"을 적은 것은 성과가 아니기 때문입니다.
//       (기간이 성과로 쓰이는 "3개월에서 1개월로", "2주 단축"은 아래 BEFORE_AFTER·DURATION_RESULT가 따로 인정합니다.)
const METRIC = /\d[\d,.]*\s*(?:%|퍼센트|배|건|명|개(?!월)|원|만\s?원|억|초|분|시간|일|주|회|점|위|등|ms|kb|mb|gb|tb|건수|곳|종|편)/iu;
// "1.2초에서 0.3초로" 같은 전후 비교는 특히 강한 신호입니다(기간끼리의 비교도 성과로 인정).
const BEFORE_AFTER = /\d[\d,.]*\s*\S{0,3}\s*(?:에서|→|->|=>)\s*\d[\d,.]*/u;
// 기간 뒤에 "단축·절감·감소…" 같은 변화 동사가 붙으면 성과입니다. 예: "배포 기간을 2개월 단축"
const DURATION_RESULT = /\d[\d,.]*\s*(?:개월|달|년)(?:을|를)?\s*(?:단축|절감|줄|감소|늘|증가|앞당)/u;

export const isQuantified = (s) => METRIC.test(s) || BEFORE_AFTER.test(s) || DURATION_RESULT.test(s);

// 막연하고 상투적인 표현(변별력이 낮은 문구). [표현, 설명]
export const WEAK_PHRASES = [
  '열심히', '성실하게', '성실히', '최선을 다', '최선', '노력하겠', '노력했', '열정', '다양한 경험', '많은 경험',
  '끊임없이', '항상', '도전 정신', '도전정신', '적극적으로', '잘할 수 있', '도움이 되고 싶', '배우겠', '성장하겠', '귀사', '꼼꼼', '책임감이 강',
];

// 수동적·소극적 참여 표현 vs 주도·기여 표현
const PASSIVE = ['참여했', '참여하였', '도왔', '도와', '보조', '함께했', '지원했', '옆에서', '배웠', '견학', '수강했'];
const ACTIVE = ['주도', '설계', '구현', '개발', '제안', '개선', '구축', '작성', '분석', '기획', '도입', '운영', '최적화', '해결', '리드', '총괄', '직접', '만들었'];

// STAR 단서 단어. 문단 하나에 각 단서가 있는지 봅니다.
const STAR = {
  situation: ['상황', '당시', '문제', '불편', '어려움', '위기', '과정에서', '했을 때', '프로젝트에서', '동안', '배경', '이슈', '한계'],
  task: ['목표', '과제', '역할', '맡', '담당', '책임', '해야', '필요했', '요구'],
  action: ['구현', '개발', '설계', '분석', '도입', '제안', '개선', '정리', '작성', '조사', '구축', '운영', '시도', '해결', '만들', '적용', '진행', '기획', '조율'],
  result: ['결과', '달성', '향상', '감소', '증가', '줄였', '높였', '올랐', '단축', '절감', '성공', '수상', '선정', '개선되', '늘었', '늘렸', '확보', '성과'],
};

// 이력서 항목 단서
const SECTION_CUES = {
  education: ['학력', '학교', '대학', '졸업', '학점', '전공', '학과', '수료'],
  experience: ['경력', '프로젝트', '인턴', '근무', '활동', '경험', '아르바이트', '동아리', '실무'],
  skills: ['기술', '스킬', 'skill', '보유', '사용 가능', '다룰 수', '툴', 'tool', '언어', '프레임워크'],
  certs: ['자격', '수상', '토익', '기사', '자격증', '수료증', '인증', '공모전', 'certificate', '합격'],
};

const count = (norm, arr) => arr.reduce((n, w) => n + (norm.includes(w) ? 1 : 0), 0);

// 문단 분리: 빈 줄 기준. 빈 줄이 없으면 한 문단으로 취급.
export const paragraphs = (text) => String(text ?? '').split(/\n\s*\n/u).map((p) => p.trim()).filter(Boolean);

// 메인 분석 함수.
//   resume, cover : (이미 개인정보가 마스킹된) 텍스트
// 반환값은 review.mjs·recommend.mjs가 공통으로 사용하는 "사용자 프로필"입니다.
export function analyzeDocs({ resume = '', cover = '' }) {
  const all = `${resume}\n\n${cover}`.trim();
  const sents = sentences(all);

  const quantified = sents.filter(isQuantified);

  const weak = [];
  for (const s of sents) {
    const n = normalize(s);
    const hit = WEAK_PHRASES.filter((p) => n.includes(p));
    if (hit.length && !isQuantified(s)) weak.push({ sentence: s, phrases: hit });
  }

  const nAll = normalize(all);
  const passive = count(nAll, PASSIVE);
  const active = count(nAll, ACTIVE);

  const nCover = normalize(cover);
  const star = Object.fromEntries(Object.entries(STAR).map(([k, cues]) => [k, count(nCover, cues)]));

  const nRes = normalize(resume);
  const sections = Object.fromEntries(Object.entries(SECTION_CUES).map(([k, cues]) => [k, count(nRes, cues) > 0]));
  sections.contact = /\[(?:이메일|전화번호)\]/u.test(resume);

  return {
    resume, cover, all,
    resumeLen: resume.replace(/\s+/gu, '').length,
    coverLen: cover.replace(/\s+/gu, '').length,
    sentenceCount: sents.length,
    quantified, weak, passive, active, star, sections,
    coverParagraphs: paragraphs(cover),
  };
}
