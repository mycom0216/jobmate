"""발표자료 생성: python tools/build_deck.py  →  docs/JobMate_발표자료.pptx
python-pptx로 슬라이드를 코드로 만듭니다(수정은 이 파일을 고치고 다시 실행). 슬라이드 노트에 발표 멘트를 넣었습니다.
"""
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "docs" / "images"
FONT = "Malgun Gothic"
INK, MUTED = RGBColor(0x1C, 0x23, 0x33), RGBColor(0x66, 0x70, 0x85)
BRAND, SOFT, WHITE = RGBColor(0x25, 0x63, 0xEB), RGBColor(0xEA, 0xF1, 0xFF), RGBColor(0xFF, 0xFF, 0xFF)
OK, WARN, BAD, LINE = RGBColor(0x0F, 0x9D, 0x6B), RGBColor(0xD9, 0x77, 0x06), RGBColor(0xD9, 0x2D, 0x20), RGBColor(0xE4, 0xE8, 0xF0)

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
BLANK = prs.slide_layouts[6]
N = 15


def text(slide, x, y, w, h, s, size=18, bold=False, color=INK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    for i, ln in enumerate(s if isinstance(s, list) else [s]):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        r = p.add_run()
        r.text = ln
        r.font.size, r.font.bold, r.font.name = Pt(size), bold, FONT
        r.font.color.rgb = color
        p.space_after = Pt(4)
    return tb


def box(slide, x, y, w, h, fill=SOFT, line=None, shape=MSO_SHAPE.ROUNDED_RECTANGLE):
    s = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line:
        s.line.color.rgb = line
        s.line.width = Pt(1)
    else:
        s.line.fill.background()
    if shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = 0.08
    s.shadow.inherit = False
    return s


def card(slide, x, y, w, h, title, body, accent=BRAND, tsize=17, bsize=14):
    box(slide, x, y, w, h, WHITE, LINE)
    box(slide, x, y, 0.09, h, accent, None, MSO_SHAPE.RECTANGLE)
    text(slide, x + 0.25, y + 0.12, w - 0.4, 0.5, title, tsize, True)
    text(slide, x + 0.25, y + 0.68, w - 0.4, h - 0.8, body, bsize, False, MUTED)


def base(title, n, notes=""):
    s = prs.slides.add_slide(BLANK)
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = RGBColor(0xF7, 0xF9, 0xFD)
    box(s, 0, 0, 13.333, 0.12, BRAND, None, MSO_SHAPE.RECTANGLE)
    text(s, 0.6, 0.35, 12, 0.8, title, 30, True)
    text(s, 12.0, 7.0, 1.0, 0.3, f"{n} / {N}", 11, False, MUTED, PP_ALIGN.RIGHT)
    text(s, 0.6, 7.0, 8, 0.3, "JobMate · RAG 기반 직무 추천 및 이력서·자기소개서 점검", 11, False, MUTED)
    if notes:
        s.notes_slide.notes_text_frame.text = notes
    return s


def pic(slide, name, x, y, w=None, h=None):
    kw = {"width": Inches(w)} if w else {"height": Inches(h)}
    p = slide.shapes.add_picture(str(IMG / name), Inches(x), Inches(y), **kw)
    p.line.color.rgb = LINE
    p.line.width = Pt(1)


# 1 표지
s = prs.slides.add_slide(BLANK)
s.background.fill.solid()
s.background.fill.fore_color.rgb = BRAND
text(s, 0.9, 2.0, 11, 1.2, "JobMate", 60, True, WHITE)
text(s, 0.9, 3.25, 11.8, 1.0, "RAG 기반 직무 추천 및 이력서·자기소개서 점검·보완 시스템", 30, False, WHITE)
text(s, 0.9, 4.5, 11.5, 0.5, "근거를 보여 주고, 없는 경력은 지어내지 않는 취업 서류 도우미", 18, False, RGBColor(0xDB, 0xE7, 0xFF))
text(s, 0.9, 6.3, 11.5, 0.5, "인공지능 응용 시스템 개발 종합 프로젝트 · 기획서 2026.12.04 · 발표 2026.12.30 · 반재영", 14, False, RGBColor(0xDB, 0xE7, 0xFF))
s.notes_slide.notes_text_frame.text = "안녕하세요. 이력서와 자기소개서를 분석해 어울리는 직무를 추천하고 직무에 맞게 점검·보완해 주는 JobMate를 소개하겠습니다."

# 2 문제
s = base("왜 만들었나: 서류를 쓰고도 확신이 없다", 2, "직무 방향과 문서 품질을 객관적으로 확인하기 어렵고, 일반 챗봇은 없는 경험을 지어낼 위험이 있어 면접에서 문제가 됩니다.")
card(s, 0.6, 1.5, 3.9, 2.6, "① 어떤 직무가 맞지?", "전공·경험은 있는데 직무 이름과 연결하지 못합니다.")
card(s, 4.7, 1.5, 3.9, 2.6, "② 문서가 그 직무에 맞나?", "경험만 나열하고 직무 역량·성과 수치·내가 한 일이 안 보여도 스스로 알기 어렵습니다.", WARN)
card(s, 8.8, 1.5, 3.9, 2.6, "③ AI 첨삭은 믿어도 되나?", "없는 경력·수치를 그럴듯하게 만들어 내면 면접에서 거짓이 드러납니다.", BAD)
box(s, 0.6, 4.6, 12.1, 1.7, BRAND)
text(s, 0.9, 4.75, 11.5, 0.5, "해결 방향", 18, True, WHITE)
text(s, 0.9, 5.3, 11.5, 0.9, ["직무 추천 → 직무 기준 점검 → 문장 보완, 모든 조언에 근거(출처) 표시", "AI 제안은 원문에 없는 숫자·기술이 있으면 폐기"], 17, False, WHITE)

# 3 기능
s = base("핵심 기능 5가지", 3, "추천, 점검, 보완, 근거 표시가 하나의 흐름으로 이어집니다.")
feats = [("직무 추천 Top 3", "역량 사전 + RAG 검색 + 행동어로 적합도·보유/부족 역량·신뢰도 제시", BRAND),
         ("8항목 점검(100점)", "핵심 역량·정량 성과·STAR·직무 연결·주도성·상투 표현·구성·분량, 문제 문장을 원문 인용", OK),
         ("보완 제안", "AI 재작성 후 검증 통과분만 채택, 아니면 빈칸 채우기 틀", WARN),
         ("근거 표시(RAG)", "추천·점검·보완마다 참고한 지식 청크 ID·제목 표시", BRAND),
         ("채용 공고 점검", "공고의 자격요건·우대사항을 서류와 한 줄씩 대조, 학력·경력 조건 안내", WARN)]
for i, (t, b, c) in enumerate(feats):
    card(s, 0.6 + (i % 2) * 6.15, 1.35 + (i // 2) * 1.8, 5.95, 1.6, t, b, c, 18, 13)
text(s, 0.6, 6.62, 12, 0.35, "기술: Node.js 24 · SQLite · BM25(+임베딩) · Claude / ChatGPT / Ollama 선택 · 외부 npm 패키지 0개", 14, False, MUTED)

# 4 화면 추천
s = base("① 직무 추천 화면", 4, "샘플 문서를 넣으면 개인정보를 가리고 Top 3를 보여 줍니다. 카드에는 적합도, 보유·부족 역량, 이유와 근거 청크가 있습니다. 직무는 직접 선택할 수도 있습니다.")
pic(s, "crop-recommend.png", 0.6, 1.4, w=8.0)
card(s, 8.9, 1.5, 3.9, 1.7, "근거와 함께", "✓ 보유 역량 / ＋ 부족 역량\n참고한 지식 청크 표시", BRAND, 16, 13)
card(s, 8.9, 3.4, 3.9, 1.7, "신뢰도 안내", "1·2위 격차가 작거나 단서가 부족하면 직접 선택하도록 안내", WARN, 16, 13)
card(s, 8.9, 5.3, 3.9, 1.5, "개인정보 마스킹", "전화·이메일·주민번호는 분석 전에 가림", OK, 16, 13)

# 5 화면 점검
s = base("② 직무 맞춤 점검 화면", 5, "점수만 주지 않고 문제가 된 원문 문장을 인용하고 고치는 방법과 근거 가이드를 보여 줍니다.")
pic(s, "crop-review.png", 0.6, 1.4, w=7.6)
card(s, 8.5, 1.5, 4.3, 1.7, "문장 단위 근거", "'열심히', '성실하게' 같은 문장을 그대로 인용해 보여 줍니다", BAD, 16, 13)
card(s, 8.5, 3.4, 4.3, 1.7, "고치는 방법", "수치 넣기, 결과 보강, 내가 한 일 중심으로", WARN, 16, 13)
card(s, 8.5, 5.3, 4.3, 1.5, "출처 표시", "항목마다 근거 가이드(GEN-05 등)", BRAND, 16, 13)

# 6 보완 화면
s = base("③ 보완 제안 화면", 6, "AI가 다듬은 문장은 검증을 통과해야 채택됩니다. 검증에 실패하면 이유와 함께 빈칸 채우기 틀로 대체합니다. 대괄호는 사용자가 직접 채워야 합니다.")
pic(s, "crop-revise.png", 0.6, 1.4, w=7.4)
card(s, 8.3, 1.5, 4.5, 1.7, "AI 제안 / 빈칸 틀", "배지로 생성 방식을 구분하고 실패 이유를 표시", BRAND, 16, 13)
card(s, 8.3, 3.4, 4.5, 1.7, "지어내지 않는다", "대괄호 [ ]는 직접 채우기. 사실과 다르면 고치라는 경고", BAD, 16, 13)
card(s, 8.3, 5.3, 4.5, 1.5, "수정 후 재점검", "점수 변화를 기록으로 확인", OK, 16, 13)

# 7 구조
s = base("시스템 구조", 7, "http 층에서 검증·제한·보안 헤더를 처리하고 app 층이 업무 흐름을 조립합니다. 분석과 점수는 규칙, 검색은 RAG, LLM은 재작성에만 씁니다.")
for i, (t, b) in enumerate([("브라우저", "입력·점검·보완"), ("http.mjs", "검증·제한·보안"), ("app.mjs", "업무 흐름"), ("SQLite", "11개 테이블")]):
    x = 0.6 + i * 3.15
    box(s, x, 1.5, 2.7, 1.2, WHITE, BRAND)
    text(s, x, 1.6, 2.7, 0.5, t, 17, True, BRAND, PP_ALIGN.CENTER)
    text(s, x, 2.15, 2.7, 0.5, b, 13, False, MUTED, PP_ALIGN.CENTER)
mods = [("text · profile", "마스킹, 역량·수치·STAR 추출(규칙)", OK), ("rag · kb", "BM25(+임베딩) 검색, 청크 60개", BRAND), ("recommend · review", "추천 점수, 8항목 점검", BRAND), ("revise · llm", "재작성 + 사후 검증, Claude/ChatGPT/Ollama", WARN)]
for i, (t, b, c) in enumerate(mods):
    card(s, 0.6 + i * 3.1, 3.2, 2.95, 2.6, t, b, c, 16, 13)
text(s, 0.6, 6.1, 12, 0.6, "LLM이 없어도 추천·점검은 그대로, 보완은 빈칸 틀로 동작 (NFR-01)", 16, True, BRAND)

# 7-2 순서도
s = base("처리 순서도와 개발 절차 순서도", 8, "왼쪽은 개발 절차, 오른쪽은 프로그램 처리 순서도입니다. 입력 검증, 신뢰도 낮음, AI 사용 불가, 검증 실패 같은 분기를 모두 처리합니다.")
pic(s, "flow-dev.png", 0.6, 1.25, h=5.6)
pic(s, "flow-system.png", 5.3, 1.25, h=5.6)
card(s, 9.9, 1.5, 2.9, 2.4, "개발 절차", "기획 → 설계 → 분석·구현 → 테스트 → 유지보수, 결함 시 구현으로 반복", BRAND, 15, 12)
card(s, 9.9, 4.1, 2.9, 2.6, "처리 흐름", "입력 → 마스킹 → 추천 → 점검 → 보완(AI/빈칸 틀) → 저장 → 재점검", OK, 15, 12)

# 8 RAG
s = base("RAG 파이프라인: 어디에 검색을 썼나", 9, "사용자 문서를 질의로 직무 청크를 검색해 추천 점수, 점검 근거, LLM 프롬프트 세 곳에 씁니다. 한국어는 어절과 글자 바이그램으로 조사 변화에 견딥니다.")
steps = [("1 색인", "직무 13종×4 + 공통 8 = 청크 60개 → BM25 색인"), ("2 검색", "사용자 문서/문장을 질의로 상위 청크"), ("3 보강", "청크를 프롬프트 '작성 가이드'로, 화면엔 출처로"), ("4 생성·검증", "원문 사실만 재작성, 새 숫자·기술명 차단")]
for i, (t, b) in enumerate(steps):
    card(s, 0.6 + i * 3.1, 1.6, 2.95, 2.6, t, b, BRAND, 17, 14)
box(s, 0.6, 4.6, 12.1, 1.9, SOFT)
text(s, 0.9, 4.75, 11.5, 1.7, ["한국어 처리: 조사 제거 + 글자 2개씩(바이그램) → '백엔드를/는/로'를 같은 토큰으로", "검색 모드: BM25 기본, Ollama 임베딩이 있으면 0.5 : 0.5 하이브리드(없어도 동작)", "사용처: ① 직무 추천 점수  ② 점검 근거 가이드  ③ LLM 보완 프롬프트"], 15, False, INK)

# 9 점수 + 환각
s = base("추천 점수와 환각 방지", 10, "추천은 세 신호의 가중합이고 여러 직무에 흔한 기술은 특이도로 낮춥니다. 보완은 LLM을 믿지 않고 결과를 원문과 대조합니다.")
card(s, 0.6, 1.5, 5.9, 2.5, "추천 적합도", "0.40 × 역량 일치도(특이도 가중)\n+ 0.50 × RAG 검색 유사도\n+ 0.10 × 직무 행동어", BRAND, 18, 16)
card(s, 6.8, 1.5, 5.9, 2.5, "신뢰도 low/medium/high", "점수가 낮거나 찾은 역량이 2개 미만이면 low, 1·2위 격차 3점 미만이면 medium", WARN, 18, 15)
box(s, 0.6, 4.3, 12.1, 2.4, WHITE, BAD)
text(s, 0.9, 4.4, 11.5, 0.5, "환각 방지 4중 장치", 18, True, BAD)
text(s, 0.9, 4.95, 11.5, 1.7, ["① 프롬프트: 원문에 없는 사실·숫자 금지, 빈 곳은 [수치 입력]", "② 사후 검증: 새 숫자 / 새 기술명 / 거절 문구 / 원문과 동일 → 폐기", "③ 폐기되면 빈칸 채우기 틀로 대체   ④ 화면 경고: 사실과 다르면 고쳐 쓰기"], 15, False, INK)

# 10 ERD
s = base("데이터 설계 (ERD)", 11, "기준 데이터 3개와 사용자 데이터 7개, 총 11개 테이블입니다. 외래키를 강제하고 점검 저장은 트랜잭션입니다. 개인정보는 마스킹된 텍스트만 저장합니다.")
pic(s, "erd.png", 0.6, 1.3, h=5.55)
card(s, 9.5, 1.5, 3.3, 1.5, "무결성", "FK 강제, 점검+항목 한 트랜잭션", OK, 15, 12)
card(s, 9.5, 3.2, 3.3, 1.5, "개인정보", "마스킹 저장, 익명 ID, 본인만 조회", BAD, 15, 12)
card(s, 9.5, 4.9, 3.3, 1.5, "기준 데이터", "시작 시 UPSERT로 동기화", BRAND, 15, 12)

# 11 평가 차트
s = base("추천 정확도 평가: 어려운 문서에서 RAG의 효과", 12, "쉬운 셋은 모두 100%였지만 이것은 사전을 만든 사람의 문서라 낙관적입니다. 기술명을 풀어 쓴 어려운 10건에서 사전만 쓰면 30%, RAG를 더하면 80%였습니다. 단 가상 데이터이고 가중치도 같은 셋으로 골랐습니다.")
cd = CategoryChartData()
cd.categories = ["역량 사전만", "초기 가중치(.60/.25/.15)", "전체(.40/.50/.10)", "RAG 검색만"]
cd.add_series("어려운 셋 Top-1 (%)", (30, 60, 80, 80))
gf = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.6), Inches(1.4), Inches(7.6), Inches(5.2), cd)
ch = gf.chart
ch.has_legend = False
ch.has_title = True
ch.chart_title.text_frame.text = "어려운 셋 Top-1 정확도 (%)"
ch.chart_title.text_frame.paragraphs[0].runs[0].font.size = Pt(14)
pl = ch.plots[0]
pl.has_data_labels = True
pl.data_labels.font.size = Pt(14)
pl.data_labels.position = XL_LABEL_POSITION.OUTSIDE_END
pl.series[0].format.fill.solid()
pl.series[0].format.fill.fore_color.rgb = BRAND
ch.value_axis.maximum_scale = 100
ch.value_axis.tick_labels.font.size = Pt(12)
ch.category_axis.tick_labels.font.size = Pt(12)
card(s, 8.5, 1.5, 4.3, 1.7, "쉬운 셋 26건", "Top-1 100% — 사전과 비슷한 표현이라 낙관적", WARN, 16, 13)
card(s, 8.5, 3.4, 4.3, 1.7, "어려운 셋 10건", "Top-1 80%, Top-3 100%. 오답: 프론트→PM, QA→백엔드", BRAND, 16, 13)
card(s, 8.5, 5.3, 4.3, 1.5, "한계", "가상 데이터·같은 셋으로 가중치 선택", BAD, 16, 13)

# 12 테스트
s = base("테스트와 발견한 결함", 13, "자동 테스트 32개가 통과합니다. 테스트와 실행 중 6건의 결함을 찾아 고쳤고, 가장 큰 것은 서버를 다시 켜면 시작이 실패하던 외래키 오류였습니다.")
card(s, 0.6, 1.5, 5.9, 2.4, "자동 테스트 32/32 통과", "마스킹 · 추천 · 점검 · 날조 차단 · IDOR · 경로 이탈 · 입력 한도 · 호출 제한 · 재시작", OK, 18, 14)
card(s, 6.8, 1.5, 5.9, 2.4, "실측", "추천 8.5ms · 점검 2.4ms · 규칙 보완 2.1ms (로컬 1건)\nOllama(kanana2:3b) 실호출 확인", BRAND, 18, 14)
box(s, 0.6, 4.2, 12.1, 2.5, WHITE, LINE)
text(s, 0.9, 4.3, 11.5, 0.5, "발견·수정한 결함 (일부)", 17, True)
text(s, 0.9, 4.85, 11.5, 1.8, ["재시작 시 FOREIGN KEY 오류 → INSERT OR REPLACE를 UPSERT로, 회귀 테스트 추가", "빈약한 문서가 신뢰도 high → 찾은 역량 수·행동어로 신뢰도 보정", "AI가 원문 그대로 돌려줌 → '원문 동일' 검증 추가", "지원 동기 문장이 수치 보강 대상 → 과거형·동기 문구 조건 추가"], 14, False, INK)

# 13 한계·일정
s = base("한계와 앞으로의 계획", 14, "정직하게 한계를 말씀드립니다. 평가 데이터가 가상이고 직무 지식이 예시 기준이며 인증과 파일 업로드가 없습니다. 12월에 사용자 평가와 공고 기반 점검을 추가할 계획입니다.")
card(s, 0.6, 1.5, 5.9, 3.4, "한계", "가상 평가 데이터 · 직무 지식은 예시 기준\n로그인·파일 업로드·공고 연동 없음\nClaude·ChatGPT·임베딩 실측 미완\n의미적 과장은 검증 못 함(사용자 확인 필요)", BAD, 18, 15)
card(s, 6.8, 1.5, 5.9, 3.4, "일정", "12/04 기획서 제출\n12/08 핵심 기능 완성(완료)\n12/19 사용자 평가·개선\n12/24 결과보고서·최종 산출물\n12/30 발표", BRAND, 18, 15)
text(s, 0.6, 5.3, 12, 1.0, "다음 개선: 채용 공고 붙여넣기 기반 점검 · 사용자 평가 반영 · 직무 지식 확대 · 로그인/HTTPS · 임베딩 실측", 16, False, INK)

# 14 마무리
s = prs.slides.add_slide(BLANK)
s.background.fill.solid()
s.background.fill.fore_color.rgb = BRAND
text(s, 0.9, 2.2, 11.5, 1.0, "감사합니다", 54, True, WHITE)
text(s, 0.9, 3.6, 11.5, 1.2, ["근거를 보여 주고, 사실을 지어내지 않는 서류 도우미", "질문 받겠습니다"], 24, False, RGBColor(0xDB, 0xE7, 0xFF))
text(s, 0.9, 6.2, 11.5, 0.5, "소스·문서: projects/JobMate · 실행: npm start (Node.js 24+)", 14, False, RGBColor(0xDB, 0xE7, 0xFF))

out = ROOT / "docs" / "JobMate_발표자료.pptx"
prs.save(out)
print("saved", out, "slides:", len(prs.slides))
