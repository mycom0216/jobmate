"""ERD 이미지 생성: python tools/make_erd.py  →  docs/images/erd.png
데이터정의서·기획서·발표자료에 들어가는 ERD 그림을 만듭니다. db.mjs의 SCHEMA와 같은 구조를 손으로 옮긴 것이므로,
테이블을 바꾸면 이 파일과 docs/JobMate_데이터정의서.md도 함께 고쳐야 합니다.
(그래프비즈 같은 외부 프로그램 없이 matplotlib만으로 그려 설치 부담을 줄였습니다.)
"""
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

plt.rcParams["font.family"] = "Malgun Gothic"
plt.rcParams["axes.unicode_minus"] = False

# (표 이름, 좌상단 x, y, [(구분, 컬럼)...], 색상그룹)
T = {
    "users": (0.5, 12.6, [("PK", "user_id"), ("", "created_at")], "u"),
    "feedback": (0.5, 9.4, [("PK", "feedback_id"), ("FK", "user_id"), ("", "target_type"), ("", "target_id"), ("", "helpful"), ("", "created_at")], "u"),
    "submissions": (5.6, 12.6, [("PK", "submission_id"), ("FK", "user_id"), ("", "resume_text"), ("", "cover_text"), ("", "pii_found"), ("", "created_at")], "u"),
    "recommendations": (10.7, 12.9, [("PK", "rec_id"), ("FK", "submission_id"), ("FK", "job_id"), ("", "rank"), ("", "fit"), ("", "detail")], "u"),
    "reviews": (10.7, 8.7, [("PK", "review_id"), ("FK", "submission_id"), ("FK", "job_id"), ("", "score"), ("", "grade"), ("", "created_at")], "u"),
    "review_items": (15.8, 12.9, [("PK", "item_id"), ("FK", "review_id"), ("", "item_key"), ("", "title"), ("", "got"), ("", "max"), ("", "severity"), ("", "detail"), ("", "advice"), ("FK", "guide_chunk_id")], "u"),
    "revisions": (15.8, 6.5, [("PK", "revision_id"), ("FK", "review_id"), ("", "original"), ("", "issue"), ("", "suggestion"), ("", "method"), ("", "created_at")], "u"),
    "posting_checks": (10.7, 4.5, [("PK", "posting_id"), ("FK", "submission_id"), ("FK", "job_id"), ("", "posting_text"), ("", "required_rate"), ("", "preferred_rate"), ("", "result")], "u"),
    "job_profiles": (5.6, 7.4, [("PK", "job_id"), ("", "name"), ("", "summary")], "r"),
    "job_skills": (0.5, 5.2, [("PK,FK", "job_id"), ("PK", "skill"), ("", "level")], "r"),
    "kb_chunks": (5.6, 4.0, [("PK", "chunk_id"), ("FK", "job_id"), ("", "kind"), ("", "title"), ("", "body")], "r"),
}
ROW, HEAD, W = 0.42, 0.6, 4.2
COL = {"u": ("#2563eb", "#eaf1ff"), "r": ("#0f9d6b", "#e7f8f0")}

def box(name):
    x, y, cols, g = T[name]
    return x, y, W, HEAD + ROW * len(cols)

fig, ax = plt.subplots(figsize=(21, 14))
ax.set_xlim(0, 21); ax.set_ylim(0.8, 14); ax.axis("off")
ax.text(0.5, 13.6, "JobMate ERD (SQLite, 11개 테이블)", fontsize=20, fontweight="bold", color="#1c2333")
ax.text(0.5, 13.25, "파란색: 사용자 데이터  /  초록색: 기준 데이터(앱 시작 시 코드에서 동기화)  /  1:N 관계는 부모(1) → 자식(N)", fontsize=11, color="#667085")

def side(name, side):
    x, y, w, h = box(name)
    return {"l": (x, y - h / 2), "r": (x + w, y - h / 2), "t": (x + w / 2, y), "b": (x + w / 2, y - h)}[side]

def rel(a, sa, b, sb, label="", lt=0.5, via=None):
    (x1, y1), (x2, y2) = side(a, sa), side(b, sb)
    pts = [(x1, y1)] + (via or []) + [(x2, y2)]
    for i in range(len(pts) - 1):
        last = i == len(pts) - 2
        ax.annotate("", xy=pts[i + 1], xytext=pts[i], arrowprops=dict(arrowstyle="-|>" if last else "-", color="#475467", lw=1.4, shrinkA=0, shrinkB=0))
    ax.text(x1 + (pts[1][0] - x1) * 0.12 + 0.05, y1 + (pts[1][1] - y1) * 0.12 + 0.12, "1", fontsize=10, color="#d92d20", fontweight="bold")
    px, py = pts[-2]
    ax.text(x2 + (px - x2) * 0.14 - 0.05, y2 + (py - y2) * 0.14 + 0.12, "N", fontsize=10, color="#d92d20", fontweight="bold")
    if label:
        lx, ly = (x1 + (x2 - x1) * lt, y1 + (y2 - y1) * lt) if not via else (via[0][0], via[-1][1] + 1.6)
        ax.text(lx, ly + 0.18, label, fontsize=9, color="#475467", ha="center", zorder=9, bbox=dict(fc="white", ec="none", pad=1))

rel("users", "r", "submissions", "l")
rel("users", "b", "feedback", "t")
rel("submissions", "r", "recommendations", "l")
rel("submissions", "b", "reviews", "l", "제출 1건 → 점검 N건", 0.55)
rel("reviews", "r", "review_items", "b")
rel("reviews", "r", "revisions", "t")
rel("submissions", "r", "posting_checks", "l", "공고 점검", 0.0, via=[(10.25, 11.04), (10.25, 2.67)])
rel("job_profiles", "r", "reviews", "l", "job_id (recommendations 도 동일)", 0.45)
rel("job_profiles", "l", "job_skills", "r")
rel("job_profiles", "b", "kb_chunks", "t")
rel("kb_chunks", "r", "review_items", "l", "근거 가이드(guide_chunk_id)", 0.3)

for name, (x, y, cols, g) in T.items():
    h = HEAD + ROW * len(cols)
    edge, soft = COL[g]
    ax.add_patch(FancyBboxPatch((x, y - h), W, h, boxstyle="round,pad=0.02,rounding_size=0.12", fc="white", ec=edge, lw=2, zorder=3))
    ax.add_patch(FancyBboxPatch((x, y - HEAD), W, HEAD, boxstyle="round,pad=0.02,rounding_size=0.12", fc=edge, ec=edge, lw=2, zorder=4))
    ax.text(x + W / 2, y - HEAD / 2, name, color="white", fontsize=13, fontweight="bold", ha="center", va="center", zorder=5)
    for i, (k, c) in enumerate(cols):
        yy = y - HEAD - ROW * (i + 0.5)
        if k:
            ax.text(x + 0.15, yy, k, fontsize=9, color="#b42318" if "PK" in k else "#175cd3", fontweight="bold", va="center", zorder=5)
        ax.text(x + 1.15, yy, c, fontsize=10.5, color="#1c2333", va="center", zorder=5)

out = Path(__file__).resolve().parent.parent / "docs" / "images" / "erd.png"
out.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(out, dpi=110, bbox_inches="tight", facecolor="white")
print("saved", out)
