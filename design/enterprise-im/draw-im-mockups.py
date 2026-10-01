#!/usr/bin/env python3
# 企业版 IM（「长在空间与笔记上的讨论」）· 高保真效果图（成套 6 张）
#
# ⛔ 这是**目标形态**，不是产品截图 ✗ —— 规格与方案见：
#   `docs/specs/2026-10-01-enterprise-im-requirements.md`（要什么／不要什么）
#   `docs/specs/2026-10-01-enterprise-im-spec.md`（12 条不许破的规矩）
#   `docs/plans/2026-10-01-enterprise-im-approach.md`（技术路线与架构）
# ⚠️ **产品代码一行都没落地** —— 这六张图画的是 Phase 1–3 的**目标**（见方案 §5）。
#
# ⚠️ 字体与字形（沿用 `design/sync-panel/draw-sync-panel.py` 的同一套闸门，别重犯）：
#   · PingFang.ttc 在 Pillow 下**打不开** ⇒ 用 Hiragino Sans GB.ttc **index=0**
#   · emoji/dingbat 在该字体里**无字形** ⇒ 只能走下面的 `SUBST` 替换；且**画出去的每个字**都过字形闸门，
#     缺字形 ⇒ 报出来并**非零退出**（⛔ 不许静默画出满屏方框 ✗）
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.dirname(os.path.abspath(__file__))

FONT_CANDIDATES = [
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
    ("/Library/Fonts/Arial Unicode.ttf", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
    ("C:/Windows/Fonts/msyh.ttc", 0),
    ("C:/Windows/Fonts/simhei.ttf", 0),
]


def _pick_font():
    tried = []
    for path, idx in FONT_CANDIDATES:
        if not os.path.exists(path):
            tried.append(path + "（不存在）")
            continue
        try:
            ImageFont.truetype(path, 20, index=idx)
            return path, idx
        except Exception as e:
            tried.append(path + "（打不开：%s）" % e)
    raise SystemExit("\n".join(
        ["⛔ 找不到可用的中文字体 —— 本脚本**不许**退回默认字体（那会静默画出满屏方框 ✗）。",
         "   试过："] + ["   · " + t for t in tried] +
        ["   ⇒ 请装上其中任一款，或把它的路径加进 FONT_CANDIDATES ✓"]))


F, F_INDEX = _pick_font()


def f(sz):
    return ImageFont.truetype(F, sz, index=F_INDEX)


F_T, F_H, F_B, F_S, F_XS = f(44), f(30), f(25), f(21), f(18)

SUBST = {"⭐️": "【要点】", "⭐": "【要点】", "⛔": "【禁】", "❌": "【禁】",
         "✗": "【错】", "✓": "【对】", "✅": "【对】",
         "⚠️": "【注意】", "⚠": "【注意】",
         "⇒": "→", "\ufe0f": "", "**": "", "*": ""}
DRAWN = []
ALL_BAD = []


def _emit(d, xy, s, font, fill, anchor="la"):
    for k, v in SUBST.items():
        s = s.replace(k, v)
    DRAWN.append(s)
    d.text(xy, s, font=font, fill=fill, anchor=anchor)


def _sig(font, ch):
    m = font.getmask(ch)
    try:
        b = bytes(m)
    except Exception:
        b = bytes(bytearray(m))
    return b


def missing_glyphs(font=F_XS):
    ref = _sig(font, "\ue000")
    bad = []
    for s in DRAWN:
        for ch in s:
            if ch == "\n":
                continue
            if _sig(font, ch) == ref:
                bad.append(ch)
    return sorted(set(bad))


BG = (250, 250, 252); INK = (28, 32, 38); MUT = (112, 120, 130); LINE = (214, 218, 226)
CARD = (255, 255, 255); GREY = (243, 245, 248)
BLUE = (37, 99, 235); BLUE_BG = (232, 240, 254)
GREEN = (22, 128, 74); GREEN_BG = (232, 246, 238)
AMBER = (180, 116, 16); AMBER_BG = (255, 247, 229)
RED = (190, 48, 42); RED_BG = (254, 236, 235)
PURPLE = (110, 70, 160); PURPLE_BG = (240, 234, 250)


class Sheet:
    def __init__(self, title, subtitle, w=2000, h=1400):
        global DRAWN
        DRAWN = []
        self.w, self.h = w, h
        self.img = Image.new("RGB", (w, h), BG)
        self.d = ImageDraw.Draw(self.img)
        _emit(self.d, (56, 40), title, F_T, INK, "la")
        _emit(self.d, (56, 100), subtitle, F_XS, MUT, "la")
        self.d.line([56, 138, w - 56, 138], fill=LINE, width=2)

    def save(self, name):
        bad = missing_glyphs(F_XS)
        p = os.path.join(OUT, name)
        self.img.save(p)
        print("saved %s %s ｜ 字形检查: %s" % (
            os.path.basename(p), self.img.size,
            ("⛔ 缺字形 " + " ".join(bad)) if bad else "干净（无缺字形）"))
        if bad:
            ALL_BAD.append((os.path.basename(p), bad))
        return bad

    # ── 基础件
    def card(self, x, y, w, h, edge=LINE, fill=CARD, r=14, lw=2):
        self.d.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill, outline=edge, width=lw)

    def t(self, x, y, s, font=F_B, fill=INK, anchor="la"):
        _emit(self.d, (x, y), s, font, fill, anchor)

    def head(self, x, y, s, fill=INK, anchor="la"):
        self.t(x, y, s, F_H, fill, anchor)

    def small(self, x, y, s, fill=MUT, anchor="la"):
        self.t(x, y, s, F_XS, fill, anchor)

    def chip(self, x, y, s, fg=BLUE, bg=BLUE_BG, pad=10, h=30):
        w = self.d.textlength(s, font=F_XS) + pad * 2
        self.d.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, fill=bg, outline=bg, width=1)
        _emit(self.d, (x + pad, y + h // 2), s, F_XS, fg, "lm")
        return w

    def badge(self, x, y, n, fg=(255, 255, 255), bg=RED, d0=26):
        self.d.ellipse([x, y, x + d0, y + d0], fill=bg)
        _emit(self.d, (x + d0 // 2, y + d0 // 2), str(n), F_XS, fg, "mm")

    def avatar(self, x, y, ch, d0=34, fill=BLUE_BG, fg=BLUE):
        self.d.ellipse([x, y, x + d0, y + d0], fill=fill, outline=fill)
        _emit(self.d, (x + d0 // 2, y + d0 // 2), ch, F_XS, fg, "mm")

    def rule(self, x0, y, x1, fill=LINE, w=1):
        self.d.line([x0, y, x1, y], fill=fill, width=w)

    # ── 模拟真界面：一扇 App 窗
    def app(self, x, y, w, h, space="产品研发 · 团队空间", online="3 人在线", tools=None, other=0):
        """⭐ 顶端工具栏（owner 2026-10-01 的方向）：
        ⛔ **去掉页面侧边工具条**（`RightRail.tsx` 那条「展开右侧工具」）✗ ⇒ 它的功能收入这一行 ✓
        ⛔ **顶栏只留「讨论」一颗**（「通知」已并进讨论 ✓）：@ 就地显示在讨论线旁 ✓
        ⭐ 跨空间汇总 ⇒ **挪到空间切换器**（`other` = 还有几个空间在叫你 ✓）
        ⚠️ **个人空间没有「讨论」** ✓（`tools` 由调用方给，见 sheet5 的对照）"""
        self.card(x, y, w, h)
        # 标题栏（＝顶端工具栏）
        self.d.rounded_rectangle([x, y, x + w, y + 64], radius=14, fill=GREY)
        self.d.rectangle([x, y + 40, x + w, y + 64], fill=GREY)
        self._space_switcher(x + 20, y + 10, space, other)
        # 右侧：先排按钮，再排在线数
        if tools:
            tw = sum(self._tool_w(lbl, b) for lbl, a, b in tools) + 12 * (len(tools) - 1)
            tx = x + w - 24 - self.d.textlength(online, font=F_S) - 28 - tw
            for lbl, act, bad in tools:
                tx += self._tool_btn(tx, y + 14, lbl, act, bad) + 12
        self.t(x + w - 24, y + 32, online, F_S, MUT, anchor="rm")
        self.rule(x, y + 64, x + w)
        return (x, y + 64)

    def _space_switcher(self, x, y, label, other=0):
        """⭐ 空间切换器（`other` = 还有几个**别的**空间在叫你）。
        ⛔ 它取代了顶栏那颗「通知」：合并之后**跨空间汇总**只有这一个落点 ✓"""
        tw = self.d.textlength(label, font=F_B)
        w = tw + 52
        self.d.rounded_rectangle([x, y, x + w, y + 44], radius=10, fill=CARD, outline=LINE, width=2)
        _emit(self.d, (x + 14, y + 22), label, F_B, INK, "lm")
        cx = x + w - 22
        self.d.polygon([(cx - 7, y + 17), (cx + 7, y + 17), (cx, y + 28)], fill=MUT)
        if other:
            self.badge(x + w + 8, y + 8, other, d0=24)
        return w

    def _tool_w(self, label, badge=0):
        return self.d.textlength(label, font=F_XS) + 28 + (22 if badge else 0)

    def _tool_btn(self, x, y, label, active=False, badge=0):
        w = self._tool_w(label, badge)
        self.d.rounded_rectangle([x, y, x + w, y + 36], radius=9,
                                 fill=BLUE_BG if active else CARD,
                                 outline=BLUE if active else LINE, width=2)
        _emit(self.d, (x + 14, y + 18), label, F_XS, BLUE if active else INK, "lm")
        if badge:
            self.badge(x + w - 22, y + 6, badge, d0=20)
        return w

    def switch2(self, x, y, w, a, b, active):
        """侧边栏顶部的**两级切换器**（「页面 ｜ 讨论」）——
        ⭐ owner 2026-10-01 的方向：讨论线**放进左侧边栏**，切换就在这一格 ✓"""
        self.d.rounded_rectangle([x, y, x + w, y + 40], radius=10, fill=(235, 238, 244))
        half = w // 2
        for i, lbl in enumerate((a, b)):
            on = (lbl == active)
            px = x + (i * half) + 3
            self.d.rounded_rectangle([px, y + 3, px + half - 6, y + 37], radius=8,
                                     fill=CARD if on else (235, 238, 244),
                                     outline=LINE if on else (235, 238, 244), width=1)
            _emit(self.d, (px + (half - 6) // 2, y + 20), lbl, F_XS, BLUE if on else MUT, "mm")

    def sidebar(self, x, y, w, h, tree):
        self.d.rectangle([x, y, x + w, y + h], fill=(247, 248, 251))
        self.rule(x + w, y, x + w, )
        self.d.line([x + w, y, x + w, y + h], fill=LINE, width=1)
        self.small(x + 20, y + 18, "页面")
        yy = y + 54
        for depth, label, cur in tree:
            if cur:
                self.d.rounded_rectangle([x + 10, yy - 6, x + w - 14, yy + 30], radius=8, fill=BLUE_BG)
            self.t(x + 24 + depth * 18, yy + 12, label, F_S if depth == 0 else F_XS,
                   BLUE if cur else INK, "lm")
            yy += 42
        return yy

    def note(self, x, y, w, h, title, paras):
        self.t(x + 28, y + 26, title, F_H)
        yy = y + 84
        for p in paras:
            self.t(x + 28, yy, p, F_S, MUT if p.startswith("（") else INK)
            yy += 38
        return yy


def sheet1():
    """① 页级讨论：能回复某一条，恰好两层。"""
    s = Sheet("企业版 IM · 效果图 01", "页级讨论：讨论就长在这一页笔记旁边。回复只两层（回复的回复归到根）。")
    ax, ay, aw, ah = 56, 190, 1888, 1150
    s.app(ax, ay, aw, ah, other=2, tools=[("AI 助手", False, 0), ("讨论", True, 0), ("目录", False, 0)])
    s.sidebar(ax, ay + 64, 260, ah - 64, [
        (0, "项目立项", False), (1, "会议纪要", True), (1, "需求草稿", False),
        (0, "技术方案", False), (1, "接口约定", False), (0, "发布检查", False)])
    s.note(ax + 260, ay + 64, 1000, ah - 64, "会议纪要 · 10-01",
           ["（笔记正文……）", "一、本期只做「讨论」，不做独立聊天应用。",
            "二、评论要能回复，但**只做两层**。", "三、讨论必须能一键落成笔记。"])
    # 右侧讨论抽屉
    dx, dy, dw = ax + 1260, ay + 64, 628
    s.d.rectangle([dx, dy, dx + dw, ay + ah - 64], fill=(252, 252, 254))
    s.d.line([dx, dy, dx, ay + ah - 64], fill=LINE, width=1)
    s.t(dx + 24, dy + 22, "讨论 · 本页", F_B)
    s.small(dx + dw - 24, dy + 30, "5 条", MUT, "ra")
    # 根评论
    yy = dy + 74
    s.avatar(dx + 24, yy, "王")
    s.t(dx + 68, yy + 2, "王工", F_S)
    s.small(dx + 124, yy + 6, "10:02", MUT)
    s.t(dx + 68, yy + 34, "评论要能回复，但只做两层吧？", F_S)
    s.small(dx + 68, yy + 64, "回复   ·   @提及", BLUE)
    # 两条回复（缩进）
    yy = dy + 168
    s.d.line([dx + 44, dy + 150, dx + 44, yy + 60], fill=LINE, width=2)
    s.avatar(dx + 60, yy, "李", fill=GREEN_BG, fg=GREEN)
    s.t(dx + 104, yy + 2, "李工", F_S)
    s.small(dx + 160, yy + 6, "10:05", MUT)
    s.t(dx + 104, yy + 34, "同意。回复的回复就归到根。", F_S)
    yy += 104
    s.avatar(dx + 60, yy, "赵", fill=AMBER_BG, fg=AMBER)
    s.t(dx + 104, yy + 2, "赵工", F_S)
    s.small(dx + 160, yy + 6, "10:07", MUT)
    s.t(dx + 104, yy + 34, "那深了怎么办？缩进会看不见。", F_S)
    # 输入框
    iy = ay + ah - 150
    s.d.rounded_rectangle([dx + 24, iy, dx + dw - 24, iy + 78], radius=10, fill=CARD, outline=LINE, width=2)
    s.small(dx + 40, iy + 20, "写下评论，用 @ 提及成员……", MUT)
    s.d.rounded_rectangle([dx + dw - 130, iy + 88, dx + dw - 24, iy + 128], radius=10, fill=BLUE)
    _emit(s.d, (dx + dw - 77, iy + 108), "发送", F_S, (255, 255, 255), "mm")
    # 标注
    s.chip(56, 1360 - 34, "恰好两层：回复的回复归到根", BLUE, BLUE_BG)
    s.chip(390, 1360 - 34, "讨论只在团队空间出现（个人空间不出现）", GREEN, GREEN_BG)
    s.chip(830, 1360 - 34, "⛔ 没有会话列表、没有聊天窗", RED, RED_BG)
    return s.save("效果图-01-页级讨论-两层.png")


def sheet2():
    """② 空间级讨论线：多条线，各自未读独立。"""
    s = Sheet("企业版 IM · 效果图 02", "空间级讨论线：一个空间里多条线，每条线各自的未读数是准的。")
    ax, ay, aw, ah = 56, 190, 1888, 1150
    s.app(ax, ay, aw, ah, space="产品研发 · 团队空间", online="3 人在线", other=2, tools=[("AI 助手", False, 0), ("讨论", True, 0), ("目录", False, 0)])
    # 左列：讨论线清单
    lx, ly, lw = ax + 24, ay + 64 + 24, 560
    lh = ah - 64 - 48
    s.card(lx, ly, lw, lh)
    s.t(lx + 24, ly + 20, "讨论线", F_B)
    s.small(lx + 470, ly + 28, "本空间 3 条", MUT, "ra")
    rows = [("本周进展", "3", True), ("问题清单", "0", False), ("发布检查", "1", False)]
    yy = ly + 66
    for name, n, cur in rows:
        if cur:
            s.d.rounded_rectangle([lx + 12, yy - 4, lx + lw - 12, yy + 66], radius=10, fill=BLUE_BG)
        s.t(lx + 28, yy + 14, name, F_S, BLUE if cur else INK)
        s.small(lx + 28, yy + 42, "最后一条 10:07 · 王工", MUT)
        if n != "0":
            s.badge(lx + lw - 52, yy + 16, n)
        else:
            s.chip(lx + lw - 96, yy + 18, "已读完", MUT, GREY, h=28)
        yy += 86
    # 右侧：选中那条线的消息
    rx, ry, rw = lx + lw + 32, ly, aw - (lw + 32) - 48
    s.card(rx, ry, rw, lh)
    s.t(rx + 28, ry + 20, "本周进展", F_B)
    s.chip(rx + 150, ry + 18, "空间级 · 所有人可见", GREEN, GREEN_BG, h=30)
    s.small(rx + rw - 28, ry + 28, "成员变更 → 索引/列表跟着变", MUT, "ra")
    s.rule(rx + 28, ry + 62, rx + rw - 28)
    msgs = [("王", "10:02", "这周接口那半做完了。", BLUE_BG, BLUE),
            ("李", "10:05", "前端还差一层校验，明天补。", GREEN_BG, GREEN),
            ("赵", "10:07", "那我把发布检查那条线开起来。", AMBER_BG, AMBER)]
    yy = ry + 88
    for who, tm, text, bg, fg in msgs:
        s.avatar(rx + 28, yy, who, fill=bg, fg=fg)
        s.t(rx + 74, yy + 2, who + "工", F_S)
        s.small(rx + 138, yy + 6, tm, MUT)
        s.t(rx + 74, yy + 36, text, F_S)
        yy += 104
    # 底部：两个动作
    by = ry + lh - 108
    s.d.rounded_rectangle([rx + 28, by, rx + 300, by + 56], radius=10, fill=BLUE)
    _emit(s.d, (rx + 164, by + 28), "把结论落成笔记", F_S, (255, 255, 255), "mm")
    s.d.rounded_rectangle([rx + 320, by, rx + 560, by + 56], radius=10, fill=CARD, outline=LINE, width=2)
    _emit(s.d, (rx + 440, by + 28), "标为已读", F_S, INK, "mm")
    s.chip(56, 1360 - 34, "每条线未读独立正确", BLUE, BLUE_BG)
    s.chip(330, 1360 - 34, "空间是唯一的权限边界（⛔ 不许跨空间私聊）", RED, RED_BG)
    s.chip(880, 1360 - 34, "被移出空间 → 立刻读不到（含已建立的实时连接）", AMBER, AMBER_BG)
    return s.save("效果图-02-空间级讨论线-未读独立.png")


def sheet3():
    """③ 空间切换器展开：**跨空间汇总 ＋ 系统通知**（owner 2026-10-01 选「A 全并」）。
    ⛔ 这里**不再装 @ 与回复通知** ✗ —— 那些属于某条讨论线，已就地显示（见图 06 ✓）。"""
    s = Sheet("企业版 IM · 效果图 03",
              "顶栏去掉「通知」之后：跨空间汇总与系统通知落在**空间切换器**里；@ 与回复留在讨论线旁。")
    ax, ay, aw, ah = 56, 190, 1888, 1150
    s.app(ax, ay, aw, ah, online="本空间 3 人在线", other=2,
          tools=[("AI 助手", False, 0), ("讨论", False, 0), ("目录", False, 0)])
    s.sidebar(ax, ay + 64, 260, ah - 64, [
        (0, "项目立项", False), (1, "会议纪要", True), (0, "技术方案", False), (0, "发布检查", False)])
    s.note(ax + 260, ay + 64, 900, ah - 64, "会议纪要 · 10-01",
           ["（笔记正文……）", "三、讨论必须能一键落成笔记。", "四、@ 到的人要收到提醒。"])
    # 展开的空间切换器（从标题栏那颗下拉）
    dx, dy, dw, dh = ax + 20, ay + 68, 700, 700
    s.card(dx, dy, dw, dh, edge=BLUE, lw=2)
    s.t(dx + 24, dy + 20, "切换到", F_B)
    s.small(dx + 108, dy + 28, "哪个空间在叫你，就在这一列", MUT)
    yy = dy + 62
    spaces = [("我的空间 · 个人空间", "无未读", 0, False),
              ("产品研发 · 团队空间", "3 条未读 · 其中 @ 你 1 条", 3, True),
              ("设计组 · 团队空间", "@ 你 2 条", 2, False)]
    for name, sub, n, cur in spaces:
        if cur:
            s.d.rounded_rectangle([dx + 12, yy - 4, dx + dw - 12, yy + 74], radius=10, fill=BLUE_BG)
        s.t(dx + 28, yy + 8, name, F_S, BLUE if cur else INK)
        s.small(dx + 28, yy + 40, sub, MUT)
        if n:
            s.badge(dx + dw - 52, yy + 20, n)
        if cur:
            s.chip(dx + dw - 168, yy + 42, "当前", BLUE, CARD, h=28)
        yy += 92
    s.rule(dx + 24, yy + 4, dx + dw - 24)
    s.t(dx + 24, yy + 24, "系统通知", F_B)
    s.small(dx + 130, yy + 32, "与讨论无关的那些 —— 个人空间也会有", MUT)
    yy += 68
    for who, text, when, tint in [
        ("!", "同步失败：服务器没有响应", "10:31", RED_BG),
        ("+", "你被加入「设计组 · 团队空间」", "09:12", GREEN_BG),
        ("v", "有新版本可用（1.92.0）", "08:00", GREY),
    ]:
        s.card(dx + 12, yy, dw - 24, 76, edge=LINE, fill=tint, lw=1)
        s.avatar(dx + 28, yy + 20, who, d0=34, fill=CARD, fg=INK)
        s.t(dx + 76, yy + 16, text, F_S)
        s.small(dx + 76, yy + 46, when, MUT)
        yy += 88
    # 右侧：当前空间的讨论（@ 就地显示的落点）
    rx, rw = dx + dw + 40, aw - (dw + 40) - 40
    s.card(rx, dy, rw, 420)
    s.t(rx + 28, dy + 20, "回到这个空间的「讨论」", F_B)
    s.small(rx + 28, dy + 58, "【要点】@ 与回复**不在这里**，它们就地长在讨论线上 ✓", MUT)
    s.rule(rx + 28, dy + 92, rx + rw - 28)
    yy = dy + 116
    for name, sub, n, ment in [("本周进展", "最后一条 10:07 · 王工", 3, 1),
                               ("问题清单", "最后一条 09:41 · 李工", 0, 0),
                               ("发布检查", "最后一条 10:07 · 赵工", 1, 0)]:
        s.t(rx + 28, yy + 6, name, F_S)
        s.small(rx + 28, yy + 38, sub, MUT)
        if n:
            s.badge(rx + rw - 120, yy + 16, n)
        if ment:
            s.chip(rx + rw - 68, yy + 18, "@你", AMBER, AMBER_BG, h=28)
        yy += 92
    s.card(rx + 28, dy + 420, rw - 56, 250, edge=AMBER, fill=AMBER_BG, lw=2)
    s.t(rx + 52, dy + 442, "【注意】为什么「通知」这颗按钮没了", F_S, AMBER)
    s.small(rx + 52, dy + 480, "① 今天的通知**只有 @ 一种**（kind 写死 mention），", MUT)
    s.small(rx + 52, dy + 508, "   而且带 comment_id ⇒ 它就是讨论线上的一条 ✓", MUT)
    s.small(rx + 52, dy + 544, "② 但**跨空间**那半不能并进讨论 —— 面板永远在", MUT)
    s.small(rx + 52, dy + 572, "   当前空间里 ⇒ 别的空间叫你时没地方显示 ✗", MUT)
    s.small(rx + 52, dy + 608, "⇒ 所以它挪到**空间切换器**（上面那一列）✓", MUT)
    s.chip(56, 1360 - 34, "【要点】@ 就地显示在讨论线旁（不再是单独一颗按钮）", BLUE, BLUE_BG)
    s.chip(700, 1360 - 34, "跨空间汇总 ⇒ 空间切换器（本空间那颗红点已挪到这儿）", GREEN, GREEN_BG)
    s.chip(1330, 1360 - 34, "【禁】系统通知不许混进讨论面板", RED, RED_BG)
    return s.save("效果图-03-空间切换器-跨空间与系统通知.png")


def sheet4():
    """④ 讨论变成知识 + 说真话（不显示“已送达”）。"""
    s = Sheet("企业版 IM · 效果图 04", "讨论变成知识：一键把这段结论落成笔记；且界面不承诺我们做不到的事。")
    ax, ay, aw, ah = 56, 190, 1888, 1150
    s.app(ax, ay, aw, ah, other=2, tools=[("AI 助手", False, 0), ("讨论", True, 0), ("目录", False, 0)])
    s.sidebar(ax, ay + 64, 260, ah - 64, [
        (0, "项目立项", False), (1, "会议纪要", True), (0, "本期结论", True), (0, "发布检查", False)])
    # 左：一段讨论
    lx, ly, lw = ax + 284, ay + 88, 760
    s.card(lx, ly, lw, ah - 64 - 120)
    s.t(lx + 28, ly + 20, "讨论 · 本周进展", F_B)
    s.small(lx + 28, ly + 56, "3 条 · 王工 / 李工 / 赵工", MUT)
    s.rule(lx + 28, ly + 88, lx + lw - 28)
    msgs = [("王", "这周接口那半做完了。"),
            ("李", "前端还差一层校验，明天补。"),
            ("赵", "那我把发布检查那条线开起来。")]
    yy = ly + 112
    for who, text in msgs:
        s.avatar(lx + 28, yy, who, fill=BLUE_BG, fg=BLUE)
        s.t(lx + 76, yy + 8, text, F_S)
        yy += 68
    by = ly + (ah - 64 - 120) - 92
    s.d.rounded_rectangle([lx + 28, by, lx + 340, by + 56], radius=10, fill=BLUE)
    _emit(s.d, (lx + 184, by + 28), "把这段结论落成笔记", F_S, (255, 255, 255), "mm")
    s.small(lx + 28, by + 68, "落成的是**正常笔记**，走既有的写入路径；原文回链可达。", MUT)
    # 右：生成的笔记 + 两条“说真话”
    rx, rw = lx + lw + 48, aw - lw - 48 - 284 - 24
    s.card(rx, ly, rw, 420)
    s.t(rx + 28, ly + 20, "生成的笔记（草稿）", F_B)
    s.chip(rx + 250, ly + 18, "派生，非出处", PURPLE, PURPLE_BG, h=30)
    yy = ly + 66
    for line in ["一、本期只做「讨论」，不做独立聊天应用。",
                 "二、评论要能回复，只做两层。",
                 "三、讨论必须能一键落成笔记。"]:
        s.t(rx + 28, yy, line, F_S)
        s.small(rx + rw - 28, yy + 4, "回链 →", BLUE, "ra")
        yy += 44
    s.rule(rx + 28, ly + 250, rx + rw - 28)
    s.small(rx + 28, ly + 270, "页脚：派生自「本周进展」讨论（3 条），非出处；源一改即标脏。", MUT)
    s.d.rounded_rectangle([rx + 28, ly + 316, rx + 220, ly + 372], radius=10, fill=BLUE)
    _emit(s.d, (rx + 124, ly + 344), "采用", F_S, (255, 255, 255), "mm")
    s.d.rounded_rectangle([rx + 240, ly + 316, rx + 420, ly + 372], radius=10, fill=CARD, outline=LINE, width=2)
    _emit(s.d, (rx + 330, ly + 344), "不采用", F_S, INK, "mm")
    # 说真话
    s.card(rx, ly + 448, rw, 300, edge=AMBER, fill=AMBER_BG, lw=2)
    s.t(rx + 28, ly + 470, "【注意】这条要说真话", F_B, AMBER)
    s.t(rx + 28, ly + 516, "对方不在线时，这条消息等他回来才送达。", F_S)
    s.rule(rx + 28, ly + 562, rx + rw - 28, fill=(232, 210, 160))
    s.t(rx + 28, ly + 582, "⛔ 界面不显示「已送达」", F_S, RED)
    s.small(rx + 28, ly + 622, "因为不承诺存储转发 → 服务端不存内容 → 它不该显示一个我们做不到的状态。", MUT)
    s.small(rx + 28, ly + 660, "（同 §25.1「不许静默停更」：界面上不许说假话。）", MUT)
    s.chip(56, 1360 - 34, "落成笔记走既有写入路径（⛔ 不新开写入口）", BLUE, BLUE_BG)
    s.chip(500, 1360 - 34, "动作在客户端：服务端不需要懂这次讨论", GREEN, GREEN_BG)
    s.chip(940, 1360 - 34, "⛔ 不显示「已送达」", RED, RED_BG)
    return s.save("效果图-04-讨论落成笔记与说真话.png")


def sheet5():
    """⑤ 个人空间 vs 团队空间：顶栏按钮的差别（⭐ 个人空间没有「讨论」）。"""
    s = Sheet("企业版 IM · 效果图 05",
              "同一条顶栏，两种空间：个人空间没有「讨论」那颗（团队空间才有）—— 「通知」已并进讨论。")
    TEAM = [("AI 助手", False, 0), ("讨论", True, 0), ("目录", False, 0)]
    SOLO = [("AI 助手", False, 0), ("目录", False, 0)]
    w, h = 900, 660
    lx, ly = 56, 230
    s.app(lx, ly, w, h, space="产品研发 · 团队空间", online="3 人在线", other=2, tools=TEAM)
    s.sidebar(lx, ly + 64, 240, h - 64, [(0, "项目立项", False), (1, "会议纪要", True), (0, "技术方案", False)])
    s.t(lx + 264, ly + 90, "会议纪要 · 10-01", F_H)
    s.t(lx + 264, ly + 148, "（笔记正文……）", F_S, MUT)
    s.t(lx + 264, ly + 194, "在团队空间里，", F_S)
    s.t(lx + 264, ly + 232, "顶栏只有「讨论」这一颗（通知已并进去）。", F_S)
    s.chip(lx, ly + h + 22, "团队空间：有「讨论」", BLUE, BLUE_BG)
    s.small(lx, ly + h + 66, "讨论挂在空间与页面上；@ 就在讨论线旁（空间切换器管跨空间）。", MUT)
    rx, ry = 1044, 230
    s.app(rx, ry, w, h, space="我的空间 · 个人空间", online="仅本机", tools=SOLO)
    s.sidebar(rx, ry + 64, 240, h - 64, [(0, "读书笔记", True), (1, "摘录", False), (0, "随笔", False)])
    s.t(rx + 264, ry + 90, "读书笔记", F_H)
    s.t(rx + 264, ry + 148, "（笔记正文……）", F_S, MUT)
    s.t(rx + 264, ry + 194, "个人空间里：", F_S)
    s.t(rx + 264, ry + 232, "顶栏没有「讨论」。", F_S)
    s.card(rx + 264, ry + 292, w - 288, 190, edge=AMBER, fill=AMBER_BG, lw=2)
    s.t(rx + 288, ry + 314, "【注意】为什么个人空间没有它", F_S, AMBER)
    s.small(rx + 288, ry + 352, "一个人没有第二个人可以讨论；", MUT)
    s.small(rx + 288, ry + 384, "而且个人空间是端到端加密的 ——", MUT)
    s.small(rx + 288, ry + 416, "服务端读不到正文，讨论也放不上去。", MUT)
    s.chip(rx, ry + h + 22, "个人空间：只有「AI 助手」「目录」", GREEN, GREEN_BG)
    s.small(rx, ry + h + 66, "AI 助手仍可用（接本机或内网端点）；目录仍可用。", MUT)
    s.card(56, 1180, 1888, 130, edge=BLUE, fill=BLUE_BG, lw=2)
    s.t(84, 1206, "【要点】侧边工具条撤掉之后，功能全在顶端这一行 ——", F_B, BLUE)
    s.t(84, 1256, "「AI 助手」「讨论」「目录」三颗；而个人空间只留「AI 助手」「目录」（讨论本来就不该出现在那里）。", F_S)
    s.chip(56, 1360 - 34, "【禁】侧边工具条不再存在（功能全在顶栏）", RED, RED_BG)
    s.chip(560, 1360 - 34, "个人空间没有「讨论」", GREEN, GREEN_BG)
    s.chip(960, 1360 - 34, "【禁】仍然没有会话列表／聊天窗", RED, RED_BG)
    return s.save("效果图-05-个人空间与团队空间-顶栏对照.png")


def sheet6():
    """⑥ 讨论线放进**左侧边栏**：常驻可见未读，切换就在侧边栏里（方案 A）。"""
    s = Sheet("企业版 IM · 效果图 06",
              "讨论线放进左侧边栏：不用先开面板就知道哪条线有新的；切换就在侧边栏顶部那一格。")
    TEAM = [("AI 助手", False, 0), ("讨论", True, 0), ("目录", False, 0)]
    ax, ay, aw, ah = 56, 190, 1888, 880
    s.app(ax, ay, aw, ah, other=2, tools=TEAM)
    sy, sh = ay + 64, ah - 64
    sx, sw = ax, 320
    s.d.rectangle([sx, sy, sx + sw, sy + sh], fill=(247, 248, 251))
    s.d.line([sx + sw, sy, sx + sw, sy + sh], fill=LINE, width=1)
    s.switch2(sx + 16, sy + 16, sw - 32, "页面", "讨论", "讨论")
    s.small(sx + 20, sy + 72, "本空间 3 条讨论线")
    rows = [("本周进展", "3", True, "最后一条 10:07 · 王工", 1),
            ("问题清单", "0", False, "最后一条 09:41 · 李工", 0),
            ("发布检查", "1", False, "最后一条 10:07 · 赵工", 0)]
    yy = sy + 100
    for name, n, cur, sub, ment in rows:
        if cur:
            s.d.rounded_rectangle([sx + 10, yy - 6, sx + sw - 14, yy + 66], radius=10, fill=BLUE_BG)
        s.t(sx + 26, yy + 10, name, F_S, BLUE if cur else INK)
        s.small(sx + 26, yy + 40, sub, MUT)
        if ment:
            # ⭐ @ 就地显示（owner 选「全并」后，@ 不再是一颗单独按钮 ✓）
            s.chip(sx + sw - 132, yy + 6, "@你 1", AMBER, AMBER_BG, h=26)
        if n != "0":
            s.badge(sx + sw - 52, yy + 14, n)
        else:
            s.chip(sx + sw - 96, yy + 16, "已读完", MUT, GREY, h=28)
        yy += 88
    # ⭐ 在线（按空间 —— 只显示本空间的人；owner 2026-10-01 把「通知」并掉后它需要一个新的家）
    py = yy + 16
    s.small(sx + 20, py, "在线 · 只显示本空间")
    for i, (ch, bg, fg) in enumerate([("王", BLUE_BG, BLUE), ("李", GREEN_BG, GREEN), ("赵", AMBER_BG, AMBER)]):
        ax2 = sx + 24 + i * 46
        s.avatar(ax2, py + 28, ch, d0=36, fill=bg, fg=fg)
        s.d.ellipse([ax2 + 26, py + 52, ax2 + 36, py + 62], fill=GREEN, outline=(247, 248, 251))
    s.small(sx + 24 + 3 * 46 + 4, py + 34, "均在本空间", MUT)
    s.card(sx + 16, sy + sh - 120, sw - 32, 100, edge=AMBER, fill=AMBER_BG, lw=2)
    s.t(sx + 34, sy + sh - 100, "【注意】这里不是「会话列表」", F_XS, AMBER)
    s.small(sx + 34, sy + sh - 68, "它是**本空间内**的导航；", MUT)
    s.small(sx + 34, sy + sh - 44, "跨空间那种列表才是否掉的那个。", MUT)
    # 右侧：选中那条线
    mx, mw = ax + sw, aw - sw
    # ⭐ 两级标签页「本页 ｜ 空间」（owner 2026-10-01 选 A）：页级线程与空间级线在这里切
    s.switch2(mx + 32, sy + 14, 300, "本页", "空间", "空间")
    s.small(mx + 356, sy + 30, "「本页」＝图 01 的页级线程；「空间」＝本空间的讨论线（就是左边列的这些）", MUT)
    s.t(mx + 32, sy + 82, "本周进展", F_H)
    s.chip(mx + 190, sy + 80, "空间级 · 所有人可见", GREEN, GREEN_BG, h=30)
    s.small(mx + mw - 32, sy + 90, "切走时：按你拍的「点开即推进」把这条读掉", MUT, "ra")
    s.rule(mx + 32, sy + 126, mx + mw - 32)
    msgs = [("王", "10:02", "这周接口那半做完了。", BLUE_BG, BLUE),
            ("李", "10:05", "前端还差一层校验，明天补。", GREEN_BG, GREEN),
            ("赵", "10:07", "那我把发布检查那条线开起来。", AMBER_BG, AMBER)]
    yy = sy + 152
    for who, tm, text, bg, fg in msgs:
        s.avatar(mx + 32, yy, who, fill=bg, fg=fg)
        s.t(mx + 78, yy + 2, who + "工", F_S)
        s.small(mx + 142, yy + 6, tm, MUT)
        s.t(mx + 78, yy + 36, text, F_S)
        yy += 100
    by = sy + sh - 96
    s.d.rounded_rectangle([mx + 32, by, mx + 304, by + 56], radius=10, fill=BLUE)
    _emit(s.d, (mx + 168, by + 28), "把结论落成笔记", F_S, (255, 255, 255), "mm")
    s.d.rounded_rectangle([mx + 324, by, mx + 564, by + 56], radius=10, fill=CARD, outline=LINE, width=2)
    _emit(s.d, (mx + 444, by + 28), "标为已读", F_S, INK, "mm")
    s.small(mx + 584, by + 28, "（兜底那颗：只是扫一眼时用它）", MUT, "lm")
    # 底部：三种侧边栏装法对照
    s.card(56, 1108, 1888, 218)
    s.t(84, 1128, "【要点】侧边栏里怎么装这两样东西 —— 我画的是 A", F_B, BLUE)
    bx = 96
    for tag, desc, kind in [
        ("A 顶部两级切换器（画的就是它）", "界线清楚；一眼看出现在是哪一级", "switch"),
        ("B 同一列分两段", "两样都看得见；互相挤、都要滚", "split"),
        ("C 混在页面树里", "【禁】得靠猜这条是页面还是讨论线", "mixed"),
    ]:
        s.card(bx, 1172, 592, 136, edge=BLUE if kind == "switch" else LINE,
               fill=BLUE_BG if kind == "switch" else CARD, lw=2)
        s.t(bx + 18, 1188, tag, F_XS, BLUE if kind == "switch" else INK)
        s.small(bx + 18, 1216, desc, MUT)
        # 缩略
        tx, ty = bx + 18, 1244
        s.d.rounded_rectangle([tx, ty, tx + 260, ty + 52], radius=8, fill=(247, 248, 251), outline=LINE, width=1)
        if kind == "switch":
            s.d.rounded_rectangle([tx + 8, ty + 8, tx + 252, ty + 28], radius=6, fill=(235, 238, 244))
            s.d.rounded_rectangle([tx + 8, ty + 8, tx + 130, ty + 28], radius=6, fill=CARD, outline=LINE, width=1)
            _emit(s.d, (tx + 60, ty + 18), "页面", F_XS, MUT, "mm")
            _emit(s.d, (tx + 190, ty + 18), "讨论", F_XS, BLUE, "mm")
            s.d.rounded_rectangle([tx + 8, ty + 34, tx + 252, ty + 46], radius=4, fill=BLUE_BG)
        elif kind == "split":
            s.d.rounded_rectangle([tx + 8, ty + 8, tx + 252, ty + 24], radius=4, fill=(235, 238, 244))
            s.d.rounded_rectangle([tx + 8, ty + 30, tx + 252, ty + 46], radius=4, fill=BLUE_BG)
        else:
            for k in range(3):
                s.d.rounded_rectangle([tx + 8, ty + 8 + k * 15, tx + 252, ty + 19 + k * 15], radius=4,
                                      fill=BLUE_BG if k == 1 else (235, 238, 244))
        bx += 616
    return s.save("效果图-06-讨论线放进左侧边栏.png")


if __name__ == "__main__":
    sheet1(); sheet2(); sheet3(); sheet4(); sheet5(); sheet6()
    if ALL_BAD:
        print("\n⛔ 有图缺字形 ⇒ 非零退出（⛔ 不许静默）")
        for name, bad in ALL_BAD:
            print("   · %s：%s" % (name, " ".join(bad)))
        raise SystemExit(1)
    print("\n六张全部干净 ✓")
