# JobMate 요구사항 명세서

작성일 2026-11-25 · 작성자 반재영 · 버전 1.0 · 우선순위: M(Must) S(Should) C(Could)

## 1. 기능 요구사항

| ID | 요구사항 | 상세 명세 | 우선 | 수용 기준(검증 방법) | 구현 | 상태 |
|---|---|---|---|---|---|---|
| FR-01 | 문서 입력·마스킹 | 이력서·자소서 각 12,000자 이하, 합계 80자 이상. 전화·이메일·주민번호·카드번호를 저장 전 치환 | M | 마스킹 후 원본 값이 DB·응답에 없음 / 짧음 400, 김 413 | text.mjs, app.mjs | 완료 |
| FR-02 | 직무 추천 | 직무 13종 중 Top 3, 적합도 0~100, 보유·부족 역량, 추천 이유, 근거 청크 2개, 신뢰도(high/medium/low) | M | 백엔드 문서 → 백엔드 1순위, 사전 문장 13종 모두 1순위, 단서 없는 문서 low | recommend.mjs | 완료 |
| FR-03 | 직무 맞춤 점검 | 8항목: 핵심 역량20·정량20·STAR15·직무연결10·주도성10·상투표현10·구성10·분량5, 항목별 원문 인용·조언 | M | 항목 8개·합계 100, 좋은 문서가 나쁜 문서보다 20점↑ | review.mjs | 완료 |
| FR-04 | 보완 제안 | 최대 5문장. LLM 재작성 후 검증(새 숫자·새 기술·거절 문구·원문 동일 차단), 실패·미연결 시 빈칸 틀. 수정 반영 미리보기 | M | 가짜 LLM의 날조 응답 거절, 규칙 제안에 새 숫자 없음 | revise.mjs | 완료 |
| FR-05 | 근거 표시 | 추천·점검 항목·보완마다 청크 ID·제목, 직무 가이드 열람 API | M | 점검 항목 전부 guide.id 존재 | rag.mjs, review.mjs | 완료 |
| FR-06 | 기록 | 제출별 1순위 직무, 점검 점수 이력 | S | 분석→점검 후 history에 반영 | db.mjs history | 완료 |
| FR-07 | 피드백·지표 | 추천·점검·보완 👍/👎, 제출 수·평균 점수·AI 채택률·도움됨 비율 | C | feedback 저장, stats 반영 | db.mjs stats | 완료 |
| FR-09 | 채용 공고 기반 점검 | 공고 텍스트(최대 8,000자)를 붙여 넣으면 자격요건·우대사항·담당업무를 구분(제목 없으면 전부 필수로 간주해 안내)하고, 항목마다 서류와 대조해 충족/부분/서류에서 못 찾음 + 근거 문장 표시. 필수·우대 충족도(%), 공고와 가까운 직무, 서류에 없는 요구 기술, 학력·경력 조건 안내(자동 판단 불가는 '확인 필요/미충족 가능'). 규칙 기반(LLM·외부 전송 없음), 공고 속 연락처 마스킹 | S | 기술 충족/미충족 판정, 학력 조건 안내, 파싱, 입력 오류 400·타인 제출 404, 연락처 마스킹 | posting.mjs | 완료 |
| FR-08 | 직무 직접 선택·샘플 | 추천과 무관하게 13종 중 선택, 샘플 불러오기 | S | 선택 직무로 점검 수행 | app.js | 완료 |

## 2. 비기능 요구사항

| ID | 분류 | 명세 | 우선 | 검증 | 상태 |
|---|---|---|---|---|---|
| NFR-01 | 가용성 | LLM·임베딩 없이 모든 핵심 기능 동작 | M | LLM off 상태 전체 테스트 | 완료 |
| NFR-02 | 성능 | 추천·점검·규칙 보완 각 1초 이내 | S | 실측: 추천 8.5ms, 점검 2.4ms, 규칙 보완 2.1ms(샘플 1건, 로컬) | 완료 |
| NFR-03 | 보안 | 타 사용자 제출 접근 404, userId 형식 검사, 본문 한도, 사용자당 0.7초 호출 간격, CSP 등 보안 헤더, 경로 이탈 차단, 내부 오류 비노출 | M | IDOR·`../`·413·429·헤더 테스트 | 완료 |
| NFR-04 | 개인정보 | 마스킹 저장, 익명 ID, 기본 127.0.0.1 바인딩, 키 로그 비노출 | M | 마스킹·키 비노출 테스트 | 완료 |
| NFR-05 | 신뢰성 | 점검·항목 저장 트랜잭션, 같은 DB로 재시작 가능, 외래키 강제 | S | 재시작 회귀 테스트 | 완료 |
| NFR-06 | 설치성 | Node.js 24+ 만 필요, `시작하기.cmd` 또는 `npm start` | M | 클린 실행 | 완료 |
| NFR-07 | 유지보수성 | 파일마다 목적·이유 주석, 지식베이스 분리(jobs.mjs), 테스트 52개 | S | 코드 리뷰 | 완료 |
| NFR-08 | 정확성 | AI 제안의 숫자·기술명이 원문에 있는 것만 허용 | M | guard 단위 테스트 | 완료 |

## 3. 인터페이스 명세(API)

| 메서드·경로 | 입력 | 출력 | 오류 |
|---|---|---|---|
| POST /api/analyze | userId, resume, cover | submissionId, recommendations[3], confidence, pii, summary | 400, 413, 429 |
| POST /api/review | userId, submissionId, jobId | reviewId, score, grade, items[8], strengths | 400, 404 |
| POST /api/revise | userId, reviewId, useLlm | suggestions[≤5], revisedResume/Cover, warning | 404 |
| POST /api/posting | userId, submissionId, posting | postingId, rates{required,preferred}, required/preferred/duty[], conditions[], missingSkills, jobGuess, advice | 400, 404, 413 |
| POST /api/feedback | userId, type, targetId, helpful | ok | 400, 404(없는·남의 대상) |
| GET /api/history?userId= | – | 제출·점검 이력 | 400 |
| GET /api/stats · /api/status · /api/jobs · /api/jobs/guide · /api/kb/search · /api/sample | – | 지표·상태·직무·가이드·검색·샘플 | 404 |

## 4. 데이터 요구사항
데이터정의서 참조(테이블 11개). 개인정보는 마스킹된 텍스트만 저장.

## 5. 검증 매핑
각 요구사항의 자동 테스트는 `test/jobmate.test.mjs`에서 테스트 이름 앞에 FR/NFR ID를 붙여 대응합니다. 추천 정확도는 `node tools/eval.mjs`로 측정합니다.
