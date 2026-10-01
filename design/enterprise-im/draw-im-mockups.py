#!/usr/bin/env python3
# 企业版 IM（「长在空间与笔记上的讨论」）· 高保真效果图（成套 4 张）
#
# ⛔ 这是**目标形态**，不是产品截图 ✗ —— 规格与方案见：
#   `docs/specs/2026-10-01-enterprise-im-requirements.md`（要什么／不要什么）
#   `docs/specs/2026-10-01-enterprise-im-spec.md`（12 条不许破的规矩）
#   `docs/plans/2026-10-01-enterprise-im-approach.md`（技术路线与架构）
# ⚠️ **产品代码一行都没落地** —— 这四张图画的是 Phase 1–3 的**目标**（见方案 §5）。
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
    def app(self, x, y, w, h, space="产品研发 · 团队空间", online="3 人在线"):
        self.card(x, y, w, h)
        # 标题栏
        self.d.rounded_rectangle([x, y, x + w, y + 64], radius=14, fill=GREY)
        self.d.rectangle([x, y + 40, x + w, y + 64], fill=GREY)
        self.t(x + 24, y + 32, space, F_B, anchor="lm")
        self.t(x + w - 24, y + 32, online, F_S, MUT, anchor="rm")
        self.rule(x, y + 64, x + w)
        return (x, y + 64)

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
    s.app(ax, ay, aw, ah)
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
    s.app(ax, ay, aw, ah, space="产品研发 · 团队空间", online="3 人在线")
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
    """③ 通知与在线（@提醒），且在线按「人×空间」。"""
    s = Sheet("企业版 IM · 效果图 03", "通知与在线：@ 提醒、未读；在线按「谁 · 在哪个空间」算，不是笼统一个「在线」。")
    ax, ay, aw, ah = 56, 190, 1888, 1150
    s.app(ax, ay, aw, ah, online="本空间 3 人 · 其他空间 2 人")
    s.sidebar(ax, ay + 64, 260, ah - 64, [
        (0, "项目立项", False), (1, "会议纪要", True), (0, "技术方案", False), (0, "发布检查", False)])
    s.note(ax + 260, ay + 64, 1000, ah - 64, "会议纪要 · 10-01",
           ["（笔记正文……）", "三、讨论必须能一键落成笔记。", "四、@ 到的人要收到提醒。"])
    dx, dy, dw = ax + 1260, ay + 64, 628
    s.d.rectangle([dx, dy, dx + dw, ay + ah - 64], fill=(252, 252, 254))
    s.d.line([dx, dy, dx, ay + ah - 64], fill=LINE, width=1)
    s.t(dx + 24, dy + 22, "通知", F_B)
    s.badge(dx + 96, dy + 18, 2)
    # @ 通知
    yy = dy + 78
    s.card(dx + 24, yy, dw - 48, 150, edge=BLUE, fill=BLUE_BG, lw=2)
    s.avatar(dx + 44, yy + 24, "王", fill=CARD, fg=BLUE)
    s.t(dx + 92, yy + 26, "王工 在讨论里提到了你", F_S)
    s.small(dx + 44, yy + 74, "会议纪要 · 本周进展", MUT)
    s.small(dx + 44, yy + 104, "10:02", MUT)
    s.chip(dx + dw - 168, yy + 100, "去看看", BLUE, CARD, h=30)
    yy += 174
    s.card(dx + 24, yy, dw - 48, 150, edge=LINE, lw=2)
    s.avatar(dx + 44, yy + 24, "李", fill=GREEN_BG, fg=GREEN)
    s.t(dx + 92, yy + 26, "李工 回复了你的评论", F_S)
    s.small(dx + 44, yy + 74, "会议纪要 · 本页", MUT)
    s.small(dx + 44, yy + 104, "10:05", MUT)
    # 在线区
    oy = dy + 520
    s.rule(dx + 24, oy, dx + dw - 24)
    s.t(dx + 24, oy + 22, "在线", F_B)
    s.small(dx + 96, oy + 30, "只显示与本空间有关的人", MUT)
    yy = oy + 70
    for who, where, bg, fg in [("王", "本空间 · 正在看这一页", BLUE_BG, BLUE),
                               ("李", "本空间 · 在别的页", GREEN_BG, GREEN),
                               ("赵", "本空间 · 在线", AMBER_BG, AMBER)]:
        s.avatar(dx + 28, yy, who, fill=bg, fg=fg)
        s.t(dx + 76, yy + 2, who + "工", F_S)
        s.small(dx + 76, yy + 32, where, MUT)
        s.d.ellipse([dx + 44 - 12, yy + 24, dx + 44 - 4, yy + 32], fill=GREEN, outline=CARD)
        yy += 76
    s.card(dx + 24, yy + 8, dw - 48, 96, edge=AMBER, fill=AMBER_BG, lw=2)
    s.t(dx + 44, yy + 26, "【注意】不显示其他空间的人", F_S, AMBER)
    s.small(dx + 44, yy + 60, "（在 B 空间的在线状态，不会顶掉 A 空间的）", MUT)
    s.chip(56, 1360 - 34, "@ 提醒走既有通知与已读", BLUE, BLUE_BG)
    s.chip(400, 1360 - 34, "在线 = 人 × 空间（⛔ 不是按人）", GREEN, GREEN_BG)
    s.chip(820, 1360 - 34, "⛔ 服务端不解析评论正文（@ 名单由客户端传）", RED, RED_BG)
    return s.save("效果图-03-通知与在线-按空间.png")


def sheet4():
    """④ 讨论变成知识 + 说真话（不显示“已送达”）。"""
    s = Sheet("企业版 IM · 效果图 04", "讨论变成知识：一键把这段结论落成笔记；且界面不承诺我们做不到的事。")
    ax, ay, aw, ah = 56, 190, 1888, 1150
    s.app(ax, ay, aw, ah)
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


if __name__ == "__main__":
    sheet1(); sheet2(); sheet3(); sheet4()
    if ALL_BAD:
        print("\n⛔ 有图缺字形 ⇒ 非零退出（⛔ 不许静默）")
        for name, bad in ALL_BAD:
            print("   · %s：%s" % (name, " ".join(bad)))
        raise SystemExit(1)
    print("\n四张全部干净 ✓")
