// JobMate 프론트엔드(바닐라 JS). 화면 흐름: 입력 → 추천 → 점검 → 보완.
//
// [보안 설계 — 중요]
//   사용자가 쓴 이력서 문장을 화면에 다시 보여 주므로 XSS(스크립트 삽입) 위험이 있습니다.
//   그래서 innerHTML로 문자열을 끼워 넣지 않고, 항상 textContent/DOM API(h 함수)로만 그립니다.
//   → 문장 안에 <script>가 있어도 "글자"로만 표시됩니다.

const $ = (id) => document.getElementById(id);

// DOM 요소 생성 도우미: h('div', {class:'a'}, '글자', 자식요소…). 문자열 자식은 textContent로 들어갑니다.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

// 익명 사용자 ID: 처음 방문 때 브라우저에서 난수로 만들어 localStorage에 보관합니다(실명·로그인 없음).
// 왜? 개인정보를 받지 않고도 "내 기록"을 본인에게만 보여 주기 위해서입니다.
const userId = (() => {
  let id = localStorage.getItem('jobmate.uid');
  if (!id) { id = 'u-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20); localStorage.setItem('jobmate.uid', id); }
  return id;
})();

// 서버 호출 공통 함수: 오류 응답({error})이면 예외로 바꿔 화면에 메시지를 보여 줍니다.
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, ...body }) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `오류(${res.status})`);
  return data;
}

const state = { submissionId: null, jobId: null, reviewId: null, jobs: [] };

function step(n) {
  document.querySelectorAll('#steps li').forEach((li) => {
    const s = Number(li.dataset.s);
    li.className = s === n ? 'on' : s < n ? 'done' : '';
  });
  for (let i = 2; i <= 4; i++) $('p' + i).classList.toggle('hidden', i > n);
  $('pPost').classList.toggle('hidden', n < 2); // 추천이 끝나면 공고 점검 칸도 열림
}

// 버튼 하나를 "처리 중" 상태로 잠그고 작업을 실행합니다(중복 클릭 방지 + 오류 표시).
async function busy(btn, errEl, fn, msg = '처리 중…') {
  btn.disabled = true; errEl.textContent = ''; errEl.style.color = 'var(--muted)'; errEl.textContent = msg;
  try { await fn(); errEl.textContent = ''; } catch (e) { errEl.style.color = ''; errEl.textContent = e.message; } finally { btn.disabled = false; }
}

const SEV = { ok: '양호', mid: '보완 권장', high: '우선 보완' };
const color = (s) => (s >= 80 ? '#0f9d6b' : s >= 60 ? '#d97706' : '#d92d20');

// 도움이 됐나요? 버튼: 평가를 서버에 저장(품질 개선 지표)
function feedback(type, targetId) {
  const box = h('span', { class: 'fb' });
  const send = (helpful) => api('/api/feedback', { type, targetId, helpful }).then(() => box.replaceChildren('의견 감사합니다')).catch(() => {});
  box.append('도움이 됐나요? ', h('button', { onclick: () => send(true) }, '👍'), h('button', { onclick: () => send(false) }, '👎'));
  return box;
}

// ── ① 추천 ────────────────────────────────────────────────────────────
$('go').addEventListener('click', () => busy($('go'), $('err1'), async () => {
  const r = await api('/api/analyze', { resume: $('resume').value, cover: $('cover').value });
  state.submissionId = r.submissionId;
  renderRecs(r);
  step(2);
  loadHistory();
}));

$('sample').addEventListener('click', async () => {
  const s = await api('/api/sample');
  $('resume').value = s.resume ?? ''; $('cover').value = s.cover ?? '';
});

function renderRecs(r) {
  $('pii').classList.toggle('hidden', !r.pii.length);
  $('pii').textContent = r.pii.length ? `개인정보(${r.pii.join(', ')})가 감지되어 가린 뒤 분석했습니다.` : '';
  $('conf').textContent = `${r.confidence.note} (1위 ${r.confidence.top}점, 2위와 차이 ${r.confidence.gap}점)`;
  const sel = $('jobSel'); sel.replaceChildren();
  state.jobs.forEach((j) => sel.append(h('option', { value: j.id }, j.name)));
  sel.value = r.recommendations[0].jobId; state.jobId = sel.value;
  $('recs').replaceChildren(...r.recommendations.map((c) => h('div', { class: 'card' + (c.jobId === state.jobId ? ' sel' : ''), onclick: (ev) => { sel.value = c.jobId; state.jobId = c.jobId; document.querySelectorAll('.card').forEach((x) => x.classList.remove('sel')); ev.currentTarget.classList.add('sel'); } },
    h('div', { class: 'small' }, `${c.rank}순위`),
    h('h3', {}, c.name),
    h('div', { class: 'fit' }, `${c.fit}점`),
    h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, c.fit)}%` })),
    h('div', { class: 'small' }, c.summary),
    h('div', {}, c.coreMatched.map((x) => h('span', { class: 'tag', title: x.quote ?? '' }, '✔ ' + x.name))),
    h('div', {}, c.coreMissing.slice(0, 4).map((x) => h('span', { class: 'tag miss' }, '＋ ' + x))),
    h('ul', { class: 'small' }, c.reasons.map((t) => h('li', {}, t))),
    c.evidence[0] ? h('div', { class: 'guide' }, h('b', {}, '근거 '), `${c.evidence[0].id} ${c.evidence[0].title}`) : null,
    feedback('recommendation', c.recId))));
}
$('jobSel').addEventListener('change', (e) => { state.jobId = e.target.value; });

// ── ② 점검 ────────────────────────────────────────────────────────────
async function runReview() {
  const r = await api('/api/review', { submissionId: state.submissionId, jobId: state.jobId });
  state.reviewId = r.reviewId;
  $('score').textContent = r.score; $('score').style.background = color(r.score);
  $('rtitle').textContent = `${r.jobName} 기준 점검: ${r.grade}`;
  $('rsub').textContent = r.strengths.length ? `잘된 점: ${r.strengths.join(', ')}` : '아직 두드러지는 강점 항목이 없습니다.';
  $('items').replaceChildren(...r.items.map((it) => h('div', { class: `item ${it.severity}` },
    h('div', { class: 't' }, h('span', {}, `${it.title} · ${SEV[it.severity]}`), h('span', {}, `${it.got} / ${it.max}`)),
    h('div', { class: 'small' }, it.detail),
    ...it.evidence.map((q) => h('div', { class: 'q' }, '“' + q + '”')),
    it.severity !== 'ok' ? h('div', {}, '👉 ' + it.advice) : null,
    it.guide ? h('div', { class: 'guide' }, h('b', {}, `근거 가이드 ${it.guide.id}`), ` ${it.guide.title}`) : null)));
  step(3);
  loadHistory();
}
$('rev').addEventListener('click', () => busy($('rev'), $('err2'), runReview));
$('again').addEventListener('click', () => { step(1); window.scrollTo({ top: 0, behavior: 'smooth' }); });

// ── ③ 보완 ────────────────────────────────────────────────────────────
$('fix').addEventListener('click', () => busy($('fix'), $('err3'), async () => {
  const r = await api('/api/revise', { reviewId: state.reviewId, useLlm: $('useLlm').checked });
  $('warn').textContent = r.warning + (r.llm ? ` (AI: ${r.llm})` : ' (AI 미연결: 빈칸 채우기 틀)');
  $('sugs').replaceChildren(...(r.suggestions.length ? r.suggestions.map((s) => h('div', { class: 'sug' },
    h('div', { class: 'small' }, s.issue, h('span', { class: 'badge' }, s.method === 'llm' ? 'AI 제안' : '빈칸 틀')),
    h('div', { class: 'before' }, s.original),
    h('div', { class: 'after' }, s.suggestion),
    s.note ? h('div', { class: 'small' }, s.note) : null,
    s.guides.length ? h('div', { class: 'guide' }, h('b', {}, '근거 '), s.guides.map((g) => `${g.id} ${g.title}`).join(' / ')) : null,
    feedback('revision', s.revisionId))) : [h('div', { class: 'muted' }, '고칠 문장이 발견되지 않았습니다. 훌륭합니다!')]));
  $('revCover').textContent = r.revisedCover || '(자기소개서 없음)';
  step(4);
}, 'AI가 문장을 다듬고 검증하는 중… (AI가 연결된 경우 최대 1분 정도 걸릴 수 있습니다)'));

// ── 공고 점검 ─────────────────────────────────────────────────────────
const ST = { met: ['충족', 'ok'], partial: ['부분', 'mid'], missing: ['서류에서 못 찾음', 'high'], unknown: ['판단 불가', 'mid'] };
$('postGo').addEventListener('click', () => busy($('postGo'), $('errPost'), async () => {
  const r = await api('/api/posting', { submissionId: state.submissionId, posting: $('posting').value });
  const rate = (v) => (v === null ? '해당 없음' : v + '%');
  const row = (i) => h('div', { class: 'item ' + ST[i.status][1] },
    h('div', { class: 't' }, h('span', {}, i.text), h('span', {}, ST[i.status][0])),
    i.skills.length ? h('div', {}, i.skills.map((s) => h('span', { class: 'tag' + (s.found ? '' : ' miss') }, (s.found ? '✔ ' : '＋ ') + s.name))) : null,
    i.evidence ? h('div', { class: 'q' }, '“' + i.evidence + '”') : null);
  const group = (title, arr) => arr.length ? [h('h3', {}, title), ...arr.map(row)] : [];
  $('postRes').replaceChildren(
    h('div', { class: 'scoreRow' },
      h('div', { class: 'score', style: 'background:' + color(r.rates.required ?? 0) }, rate(r.rates.required)),
      h('div', {}, h('h2', {}, `필수 요건 충족도 · 우대 ${rate(r.rates.preferred)}`),
        h('div', { class: 'muted' }, `공고와 가장 가까운 직무: ${r.jobGuess.name} (적합도 ${r.jobGuess.fit}점) — 위 선택 칸에서 이 직무로 점검하면 서류 품질까지 볼 수 있습니다.`))),
    ...r.conditions.map((c) => h('div', { class: 'notice' }, `${c.type}: ${c.text} — ${c.note}`)),
    ...group('자격요건(필수)', r.required), ...group('우대사항', r.preferred), ...group('담당업무(참고: 관련 경험 문장 찾기)', r.duty),
    ...r.advice.map((a) => h('div', { class: 'item mid' }, '👉 ' + a)),
    h('div', { class: 'small' }, r.note));
  $('postRes').classList.remove('hidden');
}));

// ── 내 기록 ───────────────────────────────────────────────────────────
async function loadHistory() {
  const rows = await api(`/api/history?userId=${encodeURIComponent(userId)}`).catch(() => []);
  const name = (id) => state.jobs.find((j) => j.id === id)?.name ?? id;
  $('hist').replaceChildren(...(rows.length ? rows.map((x) => h('div', { class: 'small' },
    `#${x.submissionId} · ${new Date(x.createdAt).toLocaleString('ko-KR')} · 1순위 ${x.top ? name(x.top.job_id) : '-'}`,
    x.reviews.length ? ' · 점검 ' + x.reviews.map((v) => `${name(v.job_id)} ${v.score}점`).join(' → ') : '')) : ['아직 기록이 없습니다.']));
}

// ── 내 기록 삭제 ──────────────────────────────────────────────────────
// 서버의 내 기록을 모두 지우고, 브라우저에 저장된 익명 ID도 버려 새 ID로 시작합니다(예전 ID로는 더 이상 아무것도 조회되지 않게).
$('forget').addEventListener('click', () => busy($('forget'), $('errForget'), async () => {
  if (!window.confirm('내 기록(제출 서류·추천·점검·보완·공고 점검·평가)을 모두 삭제합니다.\n삭제한 기록은 복구할 수 없습니다. 계속할까요?')) return;
  const r = await api('/api/forget', { confirm: true });
  try { localStorage.removeItem('jobmate.uid'); } catch { /* 저장소를 못 쓰는 환경이면 무시 */ }
  window.alert(`삭제했습니다. (제출 ${r.deleted.submissions}건, 점검 ${r.deleted.reviews}건, 보완 ${r.deleted.revisions}건, 공고 점검 ${r.deleted.postings}건, 평가 ${r.deleted.feedback}건)`);
  location.reload();
}, '삭제 중…'));

// ── AI 연결 상태 ──────────────────────────────────────────────────────
// AI가 연결되지 않았으면 이유를 보여 주고 "AI 다시 연결" 버튼을 띄웁니다(Ollama를 서버보다 늦게 켠 경우 등).
function showStatus(s) {
  $('status').textContent = `검색: ${s.retrieval} · AI: ${s.llm} · 지식 ${s.chunks ?? ''}개` + (s.llmProvider ? '' : (s.llmError ? ` — ${s.llmError}` : ''));
  $('llmRetry').classList.toggle('hidden', !!s.llmProvider);
}
$('llmRetry').addEventListener('click', async () => {
  $('status').textContent = 'AI 연결 확인 중…';
  try { const r = await api('/api/llm/reconnect', {}); const s = await api('/api/status'); showStatus({ ...s, ...r }); } catch (e) { $('status').textContent = e.message; }
});

// ── 시작 ──────────────────────────────────────────────────────────────
(async () => {
  try {
    const [s, jobs] = await Promise.all([api('/api/status'), api('/api/jobs')]);
    state.jobs = jobs;
    showStatus(s);
    loadHistory();
  } catch { $('status').textContent = '서버에 연결할 수 없습니다.'; }
})();
