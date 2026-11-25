// 서버 진입점: .env를 읽고 서비스를 만든 뒤 HTTP 서버를 엽니다.
// 기본은 127.0.0.1(내 PC에서만 접속). 이력서는 민감한 문서이므로 외부 공개를 기본값으로 하지 않습니다.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, ROOT } from './src/app.mjs';
import { createHandler } from './src/http.mjs';

// 아주 단순한 .env 로더(외부 패키지 dotenv 대신). 이미 설정된 환경변수는 덮어쓰지 않습니다.
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/u)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (m && !line.trim().startsWith('#') && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const svc = await createApp();
const port = Number(process.env.PORT) || 5400, host = process.env.HOST || '127.0.0.1';
createServer(createHandler(svc)).listen(port, host, () => {
  console.log(`JobMate 실행 중: http://${host}:${port}`);
  console.log(`  지식 청크 ${svc.chunks.length}개 · 검색 ${svc.retriever.mode} · LLM ${svc.llm.label}`);
});
