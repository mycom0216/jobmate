// ─────────────────────────────────────────────────────────────────────────────
// llm.mjs — LLM 어댑터: Claude(Anthropic) · ChatGPT(OpenAI) · 로컬 Ollama를 같은 방식으로 호출
//
// [왜 어댑터(Adapter) 패턴인가]
//   서비스 코드(revise.mjs)는 "complete({system, messages})"만 부르고, 어느 회사 모델인지 몰라도 됩니다.
//   → 모델을 바꾸거나 키가 없을 때 코드 수정 없이 환경변수(.env)만 바꾸면 됩니다.
//
// [보안 원칙]
//   - API 키는 환경변수에서만 읽고, 응답·로그·에러 메시지에 절대 싣지 않습니다.
//   - 외부 LLM에는 "개인정보가 마스킹된" 텍스트만 보냅니다(server에서 maskPII 후 전달).
//
// [키가 없어도 동작]
//   LLM이 없으면 available=false 이고, 호출자는 규칙 기반(rule) 대체 경로를 씁니다. → 데모가 절대 멈추지 않음.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULTS = {
  anthropic: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  openai: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  ollama: process.env.OLLAMA_MODEL || 'kanana2:3b',
};

export class LLM {
  // fetchFn을 주입할 수 있게 한 이유: 테스트에서 가짜 서버 응답을 끼워 넣어 "외부 호출 없이" 검증하기 위함.
  constructor({ env = process.env, provider, model, timeoutMs = 30000, fetchFn = globalThis.fetch } = {}) {
    this.env = env;
    this.wanted = (provider ?? env.LLM_PROVIDER ?? 'auto').toLowerCase();
    this.modelOverride = model ?? null;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchFn;
    this.ollamaUrl = env.OLLAMA_URL || 'http://127.0.0.1:11434';
    this.provider = 'off';
    this.model = null;
    this.available = false;
    this.lastError = null;
  }

  get label() { return this.available ? `${this.provider}:${this.model}` : '사용 안 함(규칙 기반 보완)'; }

  // 사용할 공급자를 결정합니다. auto 순서: Claude 키 → OpenAI 키 → 로컬 Ollama.
  async init() {
    const w = this.wanted;
    const pick = (p) => { this.provider = p; this.model = this.modelOverride ?? DEFAULTS[p]; this.available = true; };
    if (w === 'off') return this;
    if ((w === 'anthropic' || w === 'auto') && this.env.ANTHROPIC_API_KEY) return (pick('anthropic'), this);
    if ((w === 'openai' || w === 'auto') && this.env.OPENAI_API_KEY) return (pick('openai'), this);
    if (w === 'ollama' || w === 'auto') {
      try {
        // Ollama가 켜져 있고 원하는 모델이 설치돼 있는지 2.5초 안에 확인(오래 기다리면 서버 시작이 느려짐)
        const res = await this.fetch(`${this.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
        const names = (await res.json()).models?.map((m) => m.name) ?? [];
        const m = this.modelOverride ?? DEFAULTS.ollama;
        if (names.some((n) => n === m || n === `${m}:latest`)) { pick('ollama'); this.model = m; }
      } catch { /* Ollama 없음 → 규칙 기반으로 동작 */ }
    }
    return this;
  }

  // 공통 호출. 실패하면 예외를 던지고, 호출자가 규칙 기반으로 대체합니다.
  async complete({ system, messages, maxTokens = 300 }) {
    if (!this.available) throw new Error('llm unavailable');
    try {
      const text = await this.#call(system, messages, maxTokens, true);
      this.lastError = null;
      return text;
    } catch (e) {
      this.lastError = String(e.message ?? e).slice(0, 160); // 키가 들어갈 수 있는 상세 본문(detail)은 저장하지 않음
      throw e;
    }
  }

  async #post(url, headers, body) {
    const res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) {
      const err = new Error(`${this.provider} HTTP ${res.status}`);
      err.status = res.status; err.detail = (await res.text().catch(() => '')).slice(0, 300);
      throw err;
    }
    return res.json();
  }

  async #call(system, messages, maxTokens, withTemp) {
    try {
      if (this.provider === 'anthropic') {
        // temperature 0: 같은 입력엔 같은 출력에 가깝게(재현성·안전성)
        const body = { model: this.model, max_tokens: maxTokens, system, messages, ...(withTemp ? { temperature: 0 } : {}) };
        const data = await this.#post('https://api.anthropic.com/v1/messages', { 'x-api-key': this.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body);
        return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      }
      if (this.provider === 'openai') {
        const body = { model: this.model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...messages], ...(withTemp ? { temperature: 0 } : {}) };
        const data = await this.#post('https://api.openai.com/v1/chat/completions', { authorization: `Bearer ${this.env.OPENAI_API_KEY}` }, body);
        return String(data.choices?.[0]?.message?.content ?? '').trim();
      }
      const body = { model: this.model, stream: false, messages: [{ role: 'system', content: system }, ...messages], keep_alive: '30m', options: { temperature: 0, seed: 7, num_predict: maxTokens } };
      const data = await this.#post(`${this.ollamaUrl}/api/chat`, {}, body);
      return String(data.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(); // 추론 과정 태그 제거
    } catch (e) {
      // 일부 모델은 temperature 지정을 거부합니다. 그 때문에 400이면 한 번만 빼고 재시도.
      if (withTemp && e.status === 400 && /temperature/i.test(e.detail ?? '')) return this.#call(system, messages, maxTokens, false);
      throw e;
    }
  }
}
