// ─────────────────────────────────────────────────────────────────────────────
// rag.mjs — 검색기(Retriever): BM25 + (선택) 임베딩 하이브리드 검색
//
// [RAG의 구조 — 면접 핵심]
//   RAG = Retrieval(검색) + Augmented(보강된) + Generation(생성)
//   1) 검색: 사용자의 이력서·자소서와 관련된 직무 지식 조각(청크)을 찾는다   ← 이 파일
//   2) 보강: 찾은 조각을 LLM 프롬프트에 "근거 자료"로 붙인다               ← llm.mjs
//   3) 생성: LLM이 그 근거 안에서만 답/수정안을 만든다                     ← revise.mjs
//   → LLM이 학습한 기억에만 의존하지 않아 최신·정확한 기준을 따르고, 근거를 화면에 보여 줄 수 있습니다.
//
// [BM25란?]
//   문서 검색의 대표 점수식입니다. "질의에 있는 희귀한 단어가 문서에 많이 나올수록 높은 점수"를 줍니다.
//   (TF: 단어가 문서에 나온 횟수, IDF: 그 단어가 얼마나 드문가, 문서 길이로 보정)
//
// [왜 BM25를 기본으로, 임베딩은 선택으로 했나]
//   - BM25는 계산이 빠르고 결과를 설명할 수 있으며 외부 서비스가 필요 없습니다.
//   - 임베딩(의미 검색)은 동의어에 강하지만 모델 서버(Ollama)가 있어야 합니다.
//   → 임베딩이 가능하면 두 점수를 섞고(하이브리드), 불가능하면 BM25만 써서 "항상 동작"하게 했습니다.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tokens } from './text.mjs';

// BM25 하이퍼파라미터. K1: 단어 반복의 효과가 포화되는 속도, B: 문서 길이 보정 강도. 통념값(1.2~2.0, 0.75) 사용.
const K1 = 1.4, B = 0.75;

export class Retriever {
  constructor(chunks, { ollamaUrl = 'http://127.0.0.1:11434', embedModel = 'embeddinggemma', cacheFile = null, useEmbeddings = false } = {}) {
    this.chunks = chunks;
    this.ollamaUrl = ollamaUrl;
    this.embedModel = embedModel;
    this.cacheFile = cacheFile;
    this.useEmbeddings = useEmbeddings;
    this.vectors = null;

    // 색인(인덱스) 만들기: 청크마다 토큰별 등장 횟수(tf)와 길이를 미리 계산해 둡니다.
    // 왜 미리? 질문이 올 때마다 전체 문서를 다시 분석하면 느리기 때문입니다.
    this.docs = chunks.map((c) => {
      const toks = tokens(`${c.title} ${c.title} ${c.text}`); // 제목을 두 번 넣어 제목 일치에 가중
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { tf, len: toks.length };
    });
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1);
    // df: 각 토큰이 몇 개의 청크에 나오는가 → IDF 계산용
    this.df = new Map();
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  get mode() { return this.vectors ? 'hybrid(BM25+embedding)' : 'BM25'; }

  // IDF: 드문 토큰일수록 큼. 모든 문서에 나오는 토큰은 거의 0 → 변별력 없는 단어를 자동으로 무시합니다.
  idf(t) {
    const n = this.df.get(t) ?? 0, N = this.docs.length;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  async embed(texts, timeoutMs = 20000) {
    const res = await fetch(`${this.ollamaUrl}/api/embed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.embedModel, input: texts }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error('embed ' + res.status);
    return (await res.json()).embeddings;
  }

  // 임베딩 벡터를 미리 계산하고 파일에 캐시합니다(내용이 같으면 재계산 안 함: 해시 비교).
  // 임베딩 서버가 없으면 조용히 BM25 전용으로 동작합니다(예외를 밖으로 던지지 않음).
  async init() {
    if (!this.useEmbeddings) return this;
    const texts = this.chunks.map((c) => `${c.title}\n${c.text}`);
    const key = createHash('sha256').update(this.embedModel + JSON.stringify(texts)).digest('hex');
    try {
      if (this.cacheFile && existsSync(this.cacheFile)) {
        const cached = JSON.parse(readFileSync(this.cacheFile, 'utf8'));
        if (cached.key === key) { this.vectors = cached.vectors; return this; }
      }
      this.vectors = await this.embed(texts, 60000);
      if (this.cacheFile) writeFileSync(this.cacheFile, JSON.stringify({ key, vectors: this.vectors }));
    } catch { this.vectors = null; }
    return this;
  }

  // BM25 점수 계산. 반환: 청크 순서와 같은 배열 [{ score, coverage }]
  //   coverage = "질의 토큰 중 이 청크가 맞힌 비율(IDF 가중)" → 신뢰도 계산에 사용
  bm25(query) {
    const q = [...new Set(tokens(query, { query: true }))];
    const qWeight = q.reduce((s, t) => s + this.idf(t), 0) || 1;
    return this.docs.map((d) => {
      let score = 0, hit = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const idf = this.idf(t);
        score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / this.avgLen));
        hit += idf;
      }
      return { score, coverage: hit / qWeight };
    });
  }

  // 검색 실행.
  //   query  : 검색어(사용자 문서 전체 또는 일부)
  //   k      : 돌려줄 개수
  //   filter : (chunk) => boolean — 예: 특정 직무 + 공통 가이드만 검색
  async search(query, k = 3, filter = () => true) {
    const lex = this.bm25(query);
    let cos = null;
    if (this.vectors) {
      try {
        const [qv] = await this.embed([query.slice(0, 2000)], 8000);
        cos = this.vectors.map((v) => cosine(qv, v));
      } catch { cos = null; }
    }
    const maxBm = Math.max(...lex.map((l) => l.score), 1e-9); // 0~1로 맞추기 위한 최대값(0 나눗셈 방지)
    const rows = [];
    this.chunks.forEach((c, i) => {
      if (!filter(c)) return;
      const bn = lex[i].score / maxBm;
      const sem = cos ? cos[i] : null;
      // 하이브리드: 어휘 점수 50% + 의미 점수 50%. 코사인 0.3 이하는 사실상 무관하므로 0으로 내림.
      const fused = sem === null ? bn : 0.5 * bn + 0.5 * Math.max(0, (sem - 0.3) / 0.5);
      rows.push({ chunk: c, bm25: lex[i].score, coverage: lex[i].coverage, cosine: sem, fused });
    });
    rows.sort((a, b) => b.fused - a.fused);
    return rows.slice(0, k);
  }
}

// 코사인 유사도: 두 벡터의 방향이 얼마나 같은가(1에 가까울수록 의미가 비슷)
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}
