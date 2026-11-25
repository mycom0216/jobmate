// ─────────────────────────────────────────────────────────────────────────────
// db.mjs — 데이터 저장소(SQLite). 데이터정의서·ERD 문서의 실제 구현체입니다.
//
// [왜 SQLite인가]
//   서버 설치 없이 파일 하나로 동작하고, Node.js 24 내장 모듈(node:sqlite)이라 npm 설치도 필요 없습니다.
//   개인 프로젝트·시연 규모(동시 사용자 소수)에 충분하고, 나중에 PostgreSQL 등으로 옮기기 쉬운 표준 SQL을 썼습니다.
//
// [테이블 구성 — 11개]
//   기준 데이터(앱 시작 시 코드에서 동기화): job_profiles, job_skills, kb_chunks
//   사용자 데이터: users → submissions → recommendations / reviews → review_items / revisions / posting_checks, feedback
//
// [개인정보 처리 원칙]
//   submissions에는 "마스킹된 텍스트"만 저장합니다(전화·이메일·주민번호는 저장 전에 [ ]로 치환).
//   사용자는 익명 ID(브라우저가 만든 난수)로만 식별하며 실명·연락처를 받지 않습니다.
// ─────────────────────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS job_profiles (
  job_id TEXT PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job_skills (
  job_id TEXT NOT NULL REFERENCES job_profiles(job_id) ON DELETE CASCADE,
  skill TEXT NOT NULL, level TEXT NOT NULL CHECK (level IN ('core','nice')),
  PRIMARY KEY (job_id, skill)
);
CREATE TABLE IF NOT EXISTS kb_chunks (
  chunk_id TEXT PRIMARY KEY, job_id TEXT REFERENCES job_profiles(job_id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  submission_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  resume_text TEXT NOT NULL DEFAULT '', cover_text TEXT NOT NULL DEFAULT '',
  pii_found TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recommendations (
  rec_id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(submission_id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES job_profiles(job_id), rank INTEGER NOT NULL, fit REAL NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS reviews (
  review_id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(submission_id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES job_profiles(job_id), score INTEGER NOT NULL, grade TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_items (
  item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(review_id) ON DELETE CASCADE,
  item_key TEXT NOT NULL, title TEXT NOT NULL, got REAL NOT NULL, max REAL NOT NULL, severity TEXT NOT NULL,
  detail TEXT NOT NULL, advice TEXT NOT NULL, guide_chunk_id TEXT REFERENCES kb_chunks(chunk_id)
);
CREATE TABLE IF NOT EXISTS revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(review_id) ON DELETE CASCADE,
  original TEXT NOT NULL, issue TEXT NOT NULL, suggestion TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('llm','rule')), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posting_checks (
  posting_id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(submission_id) ON DELETE CASCADE,
  job_id TEXT REFERENCES job_profiles(job_id), posting_text TEXT NOT NULL,
  required_rate INTEGER, preferred_rate INTEGER, result TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('recommendation','review','revision')),
  target_id INTEGER NOT NULL, helpful INTEGER NOT NULL CHECK (helpful IN (0,1)), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_user ON submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_rec_sub ON recommendations(submission_id);
CREATE INDEX IF NOT EXISTS idx_rev_sub ON reviews(submission_id);
CREATE INDEX IF NOT EXISTS idx_item_rev ON review_items(review_id);
CREATE INDEX IF NOT EXISTS idx_post_sub ON posting_checks(submission_id);
`;

// 파일 경로를 주면 파일 DB, 생략하면 메모리 DB(테스트용: 끝나면 사라져 테스트끼리 간섭 없음)
export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  // WAL: 읽기와 쓰기가 서로 막지 않게 하는 저널 모드. foreign_keys: 참조 무결성(ERD의 FK)을 실제로 강제.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

const now = () => new Date().toISOString();

export class Store {
  constructor(db) { this.db = db; }

  // 직무·역량·지식 청크 같은 "기준 데이터"를 코드(jobs.mjs)와 동기화합니다.
  // 왜 DB에도 넣나? 추천·점검 결과가 외래키(FK)로 직무·근거 청크를 가리키게 해 데이터 무결성을 지키기 위함입니다.
  syncReference(jobs, chunks) {
    const db = this.db;
    db.exec('BEGIN');
    try {
      // INSERT OR REPLACE 를 쓰면 안 됩니다: REPLACE는 "기존 행 삭제 후 삽입"이라, 이미 추천·점검 기록이 참조 중인 직무 행을
      // 지우려다 외래키 오류가 납니다(서버 재시작 시 실제로 발생했던 버그). 그래서 UPSERT(있으면 갱신)를 씁니다.
      const jp = db.prepare('INSERT INTO job_profiles(job_id,name,summary) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET name=excluded.name, summary=excluded.summary');
      const js = db.prepare('INSERT INTO job_skills(job_id,skill,level) VALUES(?,?,?) ON CONFLICT(job_id,skill) DO UPDATE SET level=excluded.level');
      const kc = db.prepare('INSERT INTO kb_chunks(chunk_id,job_id,kind,title,body) VALUES(?,?,?,?,?) ON CONFLICT(chunk_id) DO UPDATE SET job_id=excluded.job_id, kind=excluded.kind, title=excluded.title, body=excluded.body');
      for (const j of jobs) {
        jp.run(j.id, j.name, j.summary);
        for (const s of j.core) js.run(j.id, s.name, 'core');
        for (const s of j.nice) js.run(j.id, s.name, 'nice');
      }
      for (const c of chunks) kc.run(c.id, c.jobId, c.kind, c.title, c.text);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  ensureUser(userId) {
    this.db.prepare('INSERT OR IGNORE INTO users(user_id,created_at) VALUES(?,?)').run(userId, now());
  }

  saveSubmission(userId, resume, cover, pii) {
    this.ensureUser(userId);
    const r = this.db.prepare('INSERT INTO submissions(user_id,resume_text,cover_text,pii_found,created_at) VALUES(?,?,?,?,?)')
      .run(userId, resume, cover, JSON.stringify(pii), now());
    return Number(r.lastInsertRowid);
  }

  // 제출 문서는 본인만 조회 가능: user_id 조건을 항상 함께 건다(다른 사용자 문서 열람 방지, IDOR 대응)
  getSubmission(submissionId, userId) {
    return this.db.prepare('SELECT * FROM submissions WHERE submission_id=? AND user_id=?').get(submissionId, userId) ?? null;
  }

  // 제출 1건과 추천 결과를 한 트랜잭션으로 저장합니다(추천 저장이 실패하면 제출도 취소 → 추천 없는 고아 제출이 남지 않음).
  saveAnalysis(userId, resume, cover, pii, recs) {
    this.db.exec('BEGIN');
    try {
      const submissionId = this.saveSubmission(userId, resume, cover, pii);
      const recIds = this.saveRecommendations(submissionId, recs);
      this.db.exec('COMMIT');
      return { submissionId, recIds };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  saveRecommendations(submissionId, recs) {
    const st = this.db.prepare('INSERT INTO recommendations(submission_id,job_id,rank,fit,detail) VALUES(?,?,?,?,?)');
    return recs.map((r) => Number(st.run(submissionId, r.jobId, r.rank, r.fit, JSON.stringify({ parts: r.parts, coreMatched: r.coreMatched.map((x) => x.name), coreMissing: r.coreMissing })).lastInsertRowid));
  }

  // 점검 결과 한 건 + 항목들을 한 트랜잭션으로 저장(중간에 실패하면 전부 취소 → 반쪽 데이터 방지)
  saveReview(submissionId, review) {
    const db = this.db;
    db.exec('BEGIN');
    try {
      const rid = Number(db.prepare('INSERT INTO reviews(submission_id,job_id,score,grade,created_at) VALUES(?,?,?,?,?)')
        .run(submissionId, review.jobId, review.score, review.grade, now()).lastInsertRowid);
      const st = db.prepare('INSERT INTO review_items(review_id,item_key,title,got,max,severity,detail,advice,guide_chunk_id) VALUES(?,?,?,?,?,?,?,?,?)');
      for (const it of review.items) st.run(rid, it.id, it.title, it.got, it.max, it.severity, it.detail, it.advice, it.guide?.id ?? null);
      db.exec('COMMIT');
      return rid;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  saveRevisions(reviewId, suggestions) {
    const st = this.db.prepare('INSERT INTO revisions(review_id,original,issue,suggestion,method,created_at) VALUES(?,?,?,?,?,?)');
    return suggestions.map((s) => Number(st.run(reviewId, s.original, s.issue, s.suggestion, s.method, now()).lastInsertRowid));
  }

  getReview(reviewId, userId) {
    return this.db.prepare(`SELECT r.* FROM reviews r JOIN submissions s ON s.submission_id=r.submission_id
                            WHERE r.review_id=? AND s.user_id=?`).get(reviewId, userId) ?? null;
  }

  // 공고 점검 결과 저장: 공고 원문과 요약 비율, 상세 결과(JSON)를 제출 건에 연결해 둡니다.
  savePosting(submissionId, postingText, result) {
    const r = this.db.prepare('INSERT INTO posting_checks(submission_id,job_id,posting_text,required_rate,preferred_rate,result,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(submissionId, result.jobGuess.jobId, postingText, result.rates.required, result.rates.preferred, JSON.stringify(result), now());
    return Number(r.lastInsertRowid);
  }

  // 피드백 대상이 "존재하고 이 사용자의 것"인지 확인합니다(없는 번호나 남의 기록에 평가가 쌓이는 것을 막음).
  ownsTarget(userId, type, id) {
    const sql = {
      recommendation: 'SELECT 1 FROM recommendations r JOIN submissions s ON s.submission_id=r.submission_id WHERE r.rec_id=? AND s.user_id=?',
      review: 'SELECT 1 FROM reviews r JOIN submissions s ON s.submission_id=r.submission_id WHERE r.review_id=? AND s.user_id=?',
      revision: 'SELECT 1 FROM revisions v JOIN reviews r ON r.review_id=v.review_id JOIN submissions s ON s.submission_id=r.submission_id WHERE v.revision_id=? AND s.user_id=?',
    }[type];
    return !!sql && !!this.db.prepare(sql).get(id, userId);
  }

  saveFeedback(userId, type, id, helpful) {
    this.ensureUser(userId);
    this.db.prepare('INSERT INTO feedback(user_id,target_type,target_id,helpful,created_at) VALUES(?,?,?,?,?)').run(userId, type, id, helpful ? 1 : 0, now());
  }

  // 내 기록: 제출 → 1순위 추천 → 점검 점수 변화(첨삭 전후 비교용)
  history(userId) {
    const subs = this.db.prepare('SELECT submission_id, created_at, length(resume_text)+length(cover_text) AS chars FROM submissions WHERE user_id=? ORDER BY submission_id DESC LIMIT 20').all(userId);
    return subs.map((s) => ({
      submissionId: s.submission_id, createdAt: s.created_at, chars: s.chars,
      top: this.db.prepare('SELECT job_id, fit FROM recommendations WHERE submission_id=? AND rank=1').get(s.submission_id) ?? null,
      reviews: this.db.prepare('SELECT review_id, job_id, score, grade, created_at FROM reviews WHERE submission_id=? ORDER BY review_id').all(s.submission_id),
      postings: this.db.prepare('SELECT posting_id, job_id, required_rate, preferred_rate, created_at FROM posting_checks WHERE submission_id=? ORDER BY posting_id').all(s.submission_id),
    }));
  }

  // 운영 지표(발표용): 누적 건수와 평균 점검 점수, 도움이 됨 비율
  stats() {
    const one = (sql) => Object.values(this.db.prepare(sql).get())[0];
    const fb = this.db.prepare('SELECT COUNT(*) n, COALESCE(SUM(helpful),0) h FROM feedback').get();
    return {
      submissions: one('SELECT COUNT(*) FROM submissions'),
      reviews: one('SELECT COUNT(*) FROM reviews'),
      avgScore: Math.round((one('SELECT AVG(score) FROM reviews') ?? 0) * 10) / 10,
      revisions: one('SELECT COUNT(*) FROM revisions'),
      llmRevisionRate: one('SELECT COUNT(*) FROM revisions') ? Math.round(one("SELECT SUM(method='llm') FROM revisions") / one('SELECT COUNT(*) FROM revisions') * 100) : 0,
      feedback: { total: fb.n, helpfulRate: fb.n ? Math.round(fb.h / fb.n * 100) : null },
      topJobs: this.db.prepare('SELECT job_id, COUNT(*) n FROM recommendations WHERE rank=1 GROUP BY job_id ORDER BY n DESC LIMIT 5').all(),
    };
  }
}
