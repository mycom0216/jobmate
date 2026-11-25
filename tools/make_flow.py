"""순서도(flowchart) 이미지 생성: python tools/make_flow.py → docs/images/flow-dev.png, flow-system.png
 - flow-dev.png    : 개발 절차 순서도(기획 → 설계 → 분석·구현 → 테스트 → 유지보수, 결함 시 되돌아가는 반복 포함)
 - flow-system.png : 프로그램 처리 순서도(입력 → 마스킹 → 추천 → 점검 → 보완 → 저장, 분기·예외 포함)
표준 순서도 기호: 둥근 사각형=시작/끝, 사각형=처리, 마름모=판단, 평행사변형=입출력.
처리 순서도는 한 쪽(세로 약 21cm)에 담기도록 2열로 배치했습니다(가로:세로 약 1:1.2).
"""
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Polygon

plt.rcParams["font.family"] = "Malgun Gothic"
OUT = Path(__file__).resolve().parent.parent / "docs" / "images"
OUT.mkdir(parents=True, exist_ok=True)
BLUE, GREEN, RED, ORANGE, INK = "#2563eb", "#0f9d6b", "#d92d20", "#d97706", "#1c2333"


class Flow:
    def __init__(self, w, h, y0=-1.2):
        self.fig, self.ax = plt.subplots(figsize=(w, h - y0 if y0 < 0 else h - y0))
        self.ax.set_xlim(-1.2, w + 0.8)
        self.ax.set_ylim(y0, h)
        self.ax.axis("off")
        self.nodes = {}

    def node(self, key, x, y, text, kind="proc", w=3.4, h=0.8):
        a = self.ax
        if kind == "term":
            a.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle="round,pad=0,rounding_size=0.3", fc=BLUE, ec=BLUE, zorder=3))
            col = "white"
        elif kind == "dec":
            hw, hh = w / 2 + 0.2, h / 2 + 0.25
            a.add_patch(Polygon([(x, y + hh), (x + hw, y), (x, y - hh), (x - hw, y)], fc="#fff7e6", ec=ORANGE, lw=1.8, zorder=3))
            col = INK
        elif kind == "io":
            s = 0.3
            a.add_patch(Polygon([(x - w / 2 + s, y + h / 2), (x + w / 2 + s, y + h / 2), (x + w / 2 - s, y - h / 2), (x - w / 2 - s, y - h / 2)], fc="#eaf1ff", ec=BLUE, lw=1.8, zorder=3))
            col = INK
        else:
            a.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle="round,pad=0,rounding_size=0.08", fc="white", ec=BLUE, lw=1.8, zorder=3))
            col = INK
        a.text(x, y, text, ha="center", va="center", fontsize=11, color=col, zorder=5, fontweight="bold" if kind == "term" else "normal")
        hh = (h / 2 + 0.25) if kind == "dec" else h / 2
        hw = (w / 2 + 0.2) if kind == "dec" else w / 2
        self.nodes[key] = (x, y, hw, hh)

    def pt(self, key, side):
        x, y, hw, hh = self.nodes[key]
        return {"t": (x, y + hh), "b": (x, y - hh), "l": (x - hw, y), "r": (x + hw, y)}[side]

    def arrow(self, a, sa, b, sb, label="", via=None, color="#475467"):
        p1, p2 = self.pt(a, sa), self.pt(b, sb)
        pts = [p1] + (via or []) + [p2]
        for i in range(len(pts) - 1):
            last = i == len(pts) - 2
            self.ax.annotate("", xy=pts[i + 1], xytext=pts[i], zorder=2,
                             arrowprops=dict(arrowstyle="-|>" if last else "-", color=color, lw=1.5, shrinkA=0, shrinkB=0))
        if label:
            mx, my = pts[0][0] + (pts[1][0] - pts[0][0]) * 0.35, pts[0][1] + (pts[1][1] - pts[0][1]) * 0.35
            self.ax.text(mx + 0.12, my + 0.08, label, fontsize=10, color=RED if label.startswith("아니") else GREEN, fontweight="bold", zorder=6,
                         bbox=dict(fc="white", ec="none", pad=1))

    def save(self, name, title):
        self.ax.text(-1.0, self.ax.get_ylim()[1] - 0.35, title, fontsize=16, fontweight="bold", color=INK)
        self.fig.savefig(OUT / name, dpi=110, bbox_inches="tight", facecolor="white")
        print("saved", OUT / name)


# ── 1) 개발 절차 순서도 ──────────────────────────────────────────────
f = Flow(9, 12.4)
f.node("s", 4.5, 11.3, "시작 (2026-11-25)", "term", 3.0, 0.7)
f.node("p1", 4.5, 10.1, "1 기획\n주제·범위 확정, 기획서 작성 (~12/04 제출)", "proc", 5.4)
f.node("p2", 4.5, 8.8, "2 설계\n요구사항 분석서·명세서, 아키텍처, ERD", "proc", 5.4)
f.node("p3", 4.5, 7.5, "3 분석·구현\n지식베이스, RAG, 추천·점검·보완, 화면 (~12/08)", "proc", 5.4)
f.node("p4", 4.5, 6.2, "4 테스트\n자동 테스트, 정확도 평가, 사용자 평가", "proc", 5.4)
f.node("d1", 4.5, 4.7, "결함·개선 사항이\n남아 있는가?", "dec", 2.6, 0.7)
f.node("p5", 4.5, 3.2, "5 유지보수\n결함 수정, 지식 보강, 문서 갱신, 결과보고서", "proc", 5.4)
f.node("p6", 4.5, 1.95, "발표자료 정리, 시연 리허설", "proc", 4.4)
f.node("e", 4.5, 0.85, "최종 발표 (2026-12-30)", "term", 3.2, 0.7)
for a, b in [("s", "p1"), ("p1", "p2"), ("p2", "p3"), ("p3", "p4"), ("p4", "d1")]:
    f.arrow(a, "b", b, "t")
f.arrow("d1", "b", "p5", "t", "아니오")
f.arrow("d1", "r", "p3", "r", "예 → 구현으로 수정", via=[(7.9, 4.7), (7.9, 7.5)], color=RED)
f.arrow("p5", "b", "p6", "t"); f.arrow("p6", "b", "e", "t")
f.save("flow-dev.png", "개발 절차 순서도 (기획 → 설계 → 분석·구현 → 테스트 → 유지보수)")

# ── 2) 프로그램 처리 순서도 (한 장에 들어가도록 2열 배치) ──────────────
# 왼쪽 열: 입력 → 마스킹 → 분석 → 추천 → 직무 선택 → 점검
# 오른쪽 열: 보완(AI/빈칸 틀) → 저장 → 재점검 → 끝  (점검 아래에서 오른쪽 위로 연결선이 올라감)
g = Flow(10.4, 13.9, y0=1.0)
g.node("s", 2.4, 12.2, "시작", "term", 2.0, 0.6)
g.node("in", 2.4, 11.2, "이력서·자기소개서 입력", "io", 3.2, 0.7)
g.node("v", 2.4, 9.9, "입력 길이\n80~12,000자?", "dec", 2.4, 0.7)
g.node("m", 2.4, 8.6, "개인정보 마스킹\n(전화·이메일·주민·카드번호)", "proc", 3.7, 0.75)
g.node("a", 2.4, 7.55, "문서 분석\n역량·성과 수치·상투 표현·STAR·구성", "proc", 3.9, 0.75)
g.node("r", 2.4, 6.5, "직무 추천(RAG 검색+역량 사전+행동어)\n→ Top 3·근거·신뢰도", "proc", 3.9, 0.75)
g.node("c", 2.4, 5.45, "신뢰도가 낮으면\n직접 선택하도록 안내", "proc", 3.4, 0.75)
g.node("sel", 2.4, 4.4, "점검할 직무 선택", "io", 3.0, 0.65)
g.node("rv", 2.4, 3.3, "8항목 점검(100점)\n문제 문장 인용·조언·RAG 근거", "proc", 3.8, 0.75)

g.node("t", 7.2, 12.2, "보완 대상 문장 선정\n(최대 5개, 없으면 건너뜀)", "proc", 3.4, 0.75)
g.node("l", 7.2, 10.8, "AI(LLM)를\n사용할 수 있는가?", "dec", 2.4, 0.7)
g.node("ai", 7.2, 9.4, "AI 재작성\n(RAG 가이드 포함)", "proc", 3.0, 0.7)
g.node("g", 7.2, 8.0, "검증 통과?\n(새 숫자·기술명 없음)", "dec", 2.4, 0.7)
g.node("rule", 7.2, 6.6, "빈칸 채우기 틀 생성\n(규칙 기반)", "proc", 3.0, 0.7)
g.node("sv", 7.2, 5.2, "결과 표시 + DB 저장\n(제출·추천·점검·보완)", "proc", 3.3, 0.75)
g.node("re", 7.2, 3.7, "수정 후\n재점검할까?", "dec", 2.0, 0.65)
g.node("e", 7.2, 2.0, "끝", "term", 1.8, 0.6)

for a, b in [("s", "in"), ("in", "v"), ("m", "a"), ("a", "r"), ("r", "c"), ("c", "sel"), ("sel", "rv")]:
    g.arrow(a, "b", b, "t")
g.arrow("v", "b", "m", "t", "예")
g.arrow("v", "l", "in", "l", "아니오", via=[(0.25, 9.9), (0.25, 11.2)])
g.ax.text(-0.05, 10.55, "오류 안내 후\n다시 입력", fontsize=9.5, color=RED, ha="center", va="center", bbox=dict(fc="white", ec="none", pad=1), zorder=7)
g.arrow("rv", "b", "t", "l", "보완 단계로", via=[(2.4, 2.2), (4.7, 2.2), (4.7, 12.2)])
g.arrow("t", "b", "l", "t")
g.arrow("l", "b", "ai", "t", "예")
g.arrow("l", "r", "rule", "r", "아니오", via=[(9.5, 10.8), (9.5, 6.6)])
g.arrow("ai", "b", "g", "t")
g.arrow("g", "b", "rule", "t", "아니오")
g.arrow("g", "l", "sv", "l", "예", via=[(5.3, 8.0), (5.3, 5.2)])
g.arrow("rule", "b", "sv", "t")
g.arrow("sv", "b", "re", "t")
g.arrow("re", "b", "e", "t", "아니오")
g.arrow("re", "r", "in", "l", "예: 문서 수정 후 다시 입력", via=[(9.9, 3.7), (9.9, 12.8), (0.0, 12.8), (0.0, 11.2)], color=RED)
g.save("flow-system.png", "JobMate 프로그램 처리 순서도")
