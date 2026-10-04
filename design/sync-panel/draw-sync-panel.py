#!/usr/bin/env python3
# 同步面板 · 高保真效果图（成套 10 张）—— 按**最新**个人版＋企业版需求
#   ⛔ 口径只许用最新的：免费版＝本地＋局域网直连（owner 2026-09-30 改定）／配对＝**比对码 20 位**（人核对）
#      / 订阅制（面板不写价格）／企业版 iroh 默认＋HTTPS 可选＋自动回退／信创＝纯 HTTPS
#      / 界面口径用「**附近的设备**」（不用"同网段/局域网直连"）／设备直连与附近设备**已收进「进阶」**
#   ⚠️ 字体与字形（今天栽过，别重犯）：PingFang.ttc 在 Pillow 下**打不开** ⇒ 用 Hiragino Sans GB.ttc **index=0**
#      emoji/dingbat（⭐⛔⚠️✅✗✓）在该字体里**无字形** ⇒ **只用** §下列已验字符：※ · → ／ ｜ ≈ ＋
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.dirname(os.path.abspath(__file__))

# ⭐ 字体探测（2026-10-01 落进产品仓时加）：按候选列表找一款能开的中文字体。
#   ⛔ **找不到就明确报错退出** ✗ —— **不许退回** `ImageFont.load_default()` ✗：
#      那样会**静默画出满屏方框** ✓（本套图第一版就栽在这 ✓）。
#   ⭐ 本机命中第一项（Hiragino Sans GB，index=0）⇒ **与原始图逐字节一致** ✓。
FONT_CANDIDATES = [
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),                    # macOS（本套图的原始字体）
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0),                      # macOS 备用
    ("/Library/Fonts/Arial Unicode.ttf", 0),                              # macOS 备用
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),        # Linux
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),                  # Linux 备用
    ("C:/Windows/Fonts/msyh.ttc", 0),                                     # Windows
    ("C:/Windows/Fonts/simhei.ttf", 0),                                   # Windows 备用
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
    raise SystemExit(
        "\n".join(["⛔ 找不到可用的中文字体 —— 本脚本**不许**退回默认字体（那会静默画出满屏方框 ✗）。",
                    "   试过："] + ["   · " + t for t in tried] +
                   ["   ⇒ 请装上其中任一款，或把它的路径加进 FONT_CANDIDATES ✓"]))

F, F_INDEX = _pick_font()

def f(sz):
    return ImageFont.truetype(F, sz, index=F_INDEX)   # ⛔ 不再静默回退 ✗
F_T, F_H, F_B, F_S, F_XS = f(44), f(30), f(25), f(21), f(18)

# ═══════════════════ ⭐ 字形闸门（本文件唯一出口 ⇒ 真画出去的字符串才被检 ✓）
# 上一轮的两处真错（已修 ✗）：
#   ① 判据本身错：`getbbox() is not None` 对**缺字形的 .notdef 方框**也返回 True ✗ ⇒ 全漏报 ✓
#      ⇒ ⭐ 改成**与 U+E000（私用区，必缺）的渲染位图做签名比对** ✓ —— 相同 ⇒ 缺字形 ✓
#   ② 只扫"整份源码"且**标题/副标题绕过 t()** ✗ ⇒ 黑名单键里的缺字形字符被当成"要用"、真用的反而漏 ✓
#      ⇒ ⭐ 改成：**所有文字只走 `_emit()`** ✓，它把**替换后的最终字符串**记进 DRAWN ✓ 再逐字测 ✓
SUBST = {"⭐️": "【要点】", "⭐": "【要点】", "⛔": "【禁】", "❌": "【禁】",
         "✗": "【错】", "✓": "【对】", "✅": "【对】",
         "⚠️": "【注意】", "⚠": "【注意】",
         "⇒": "→", "\ufe0f": "", "**": "", "*": "", "※": "·"}
DRAWN = []                                    # 真画出去的字符串（每条一份 ✓）
ALL_BAD = []                                  # ⭐ 有任何一张缺字形 ⇒ 最后非零退出 ✓（不许静默）

def _emit(d, xy, s, font, fill, anchor="la"):
    for k, v in SUBST.items(): s = s.replace(k, v)
    DRAWN.append(s)
    d.text(xy, s, font=font, fill=fill, anchor=anchor)

def _sig(font, ch):
    m = font.getmask(ch)
    try: b = bytes(m)
    except Exception: b = bytes(bytearray(m))
    return b

def missing_glyphs(font=F_XS):
    ref = _sig(font, "\ue000")                # 私用区 ⇒ 必缺 ⇒ 方框签名
    bad = []
    for s in DRAWN:
        for ch in s:
            if ch == "\n": continue
            if _sig(font, ch) == ref: bad.append(ch)
    return sorted(set(bad))


BG=(250,250,252); INK=(28,32,38); MUT=(112,120,130); LINE=(214,218,226)
CARD=(255,255,255); GREY=(243,245,248)
BLUE=(37,99,235); BLUE_BG=(232,240,254)
GREEN=(22,128,74); GREEN_BG=(232,246,238)
AMBER=(180,116,16); AMBER_BG=(255,247,229)
RED=(190,48,42); RED_BG=(254,236,235)
PURPLE=(110,70,160); PURPLE_BG=(240,234,250)

class Sheet:
    def __init__(self, title, subtitle, w=2000, h=1400):
        global DRAWN
        DRAWN = []                              # ⭐ 每张图重置 ⇒ 报告能按图给 ✓
        self.w, self.h = w, h
        self.img = Image.new("RGB", (w, h), BG); self.d = ImageDraw.Draw(self.img)
        _emit(self.d, (56, 40), title, F_T, INK, "la")       # ⭐ 也走 _emit（上一轮这里绕过了替换 ✗）
        _emit(self.d, (56, 100), subtitle, F_XS, MUT, "la")
        self.d.line([56, 138, w-56, 138], fill=LINE, width=2)
    def save(self, name):
        bad = missing_glyphs(F_XS)
        p = os.path.join(OUT, name); self.img.save(p)
        print(("saved %s %s ｜ 字形检查: %s" % (os.path.basename(p), self.img.size,
               ("⛔ 缺字形 " + " ".join(bad)) if bad else "干净（无缺字形）")))
        if bad: ALL_BAD.append((os.path.basename(p), bad))   # ⭐ 收口 ⇒ 最后非零退出 ✓
        return bad
    # ── 基础件
    def card(self, x, y, w, h, edge=LINE, fill=CARD, r=14, lw=2):
        self.d.rounded_rectangle([x, y, x+w, y+h], radius=r, fill=fill, outline=edge, width=lw)
    def t(self, x, y, s, font=F_B, fill=INK, anchor="la"):
        _emit(self.d, (x, y), s, font, fill, anchor)
    def head(self, x, y, s, fill=INK, anchor="la"): self.t(x, y, s, F_H, fill, anchor)
    def small(self, x, y, s, *args, anchor="la"):
        fill = MUT
        for a in args:                      # 容错：调用处有时把「字体」也传进来 ⇒ 只认元组（颜色）
            if isinstance(a, tuple): fill = a
        self.t(x, y, s, F_XS, fill, anchor)
    # ── 面板件（模拟真界面）
    def panel(self, x, y, w, h, title, sub=None):
        self.card(x, y, w, h)
        self.t(x+24, y+18, title, F_B)
        if sub: self.small(x+24, y+52, sub)
    def row(self, x, y, w, label, value, h=64, value_fill=MUT, arrow=True, top=True):
        if top: self.d.line([x, y, x+w, y], fill=LINE, width=1)
        self.t(x+24, y+h//2, label, F_B, anchor="lm")
        s = value if (not arrow or value.rstrip().endswith("→")) else value + "  →"
        self.t(x+w-24, y+h//2, s, F_S, value_fill, anchor="rm")
    def btn(self, x, y, w, h, label, kind="primary"):
        if kind == "primary":
            self.d.rounded_rectangle([x, y, x+w, y+h], radius=10, fill=BLUE)
            self.t(x+w//2, y+h//2, label, F_B, (255,255,255), anchor="mm")
        else:
            self.d.rounded_rectangle([x, y, x+w, y+h], radius=10, fill=(255,255,255), outline=BLUE, width=2)
            self.t(x+w//2, y+h//2, label, F_B, BLUE, anchor="mm")
    def note(self, x, y, w, lines, kind="amber"):
        cols = {"amber":(AMBER_BG,AMBER),"green":(GREEN_BG,GREEN),"red":(RED_BG,RED),
                "blue":(BLUE_BG,BLUE),"purple":(PURPLE_BG,PURPLE)}
        bg, fg = cols[kind]; h = 26 + len(lines)*30
        self.d.rounded_rectangle([x, y, x+w, y+h], radius=12, fill=bg, outline=fg, width=2)
        for i, s in enumerate(lines):
            self.t(x+18, y+16+i*30, s, F_XS, fg if i == 0 else MUT)
        return y + h
    def footer(self, y, lines):
        self.d.line([56, y, self.w-56, y], fill=LINE, width=2)
        self.t(56, y+18, "说明（口径出处逐条可核）", F_B)
        for i, s in enumerate(lines):
            self.t(56, y+62+i*28, s, F_XS, MUT)

# ═══════════════════════════ ① 面板总览（个人版 · 免费）· 进阶组【收起】
s = Sheet("同步面板 · 个人版（免费）· 总览 —— 进阶组【收起】",
          "口径：免费版＝本地＋局域网直连（owner 2026-09-30 改定）｜「设备直连／附近设备」已收进「进阶」组")
px, pw = 56, 620
s.panel(px, 176, pw, 700, "同步", "每个空间各自绑定服务器与组织空间")
s.d.ellipse([px+pw//2-86, 250, px+pw//2-74, 262], fill=GREEN)
s.t(px+pw//2, 262, "已同步", F_H, INK, anchor="mm")
s.small(px+pw//2, 286, "刚刚 · 我的工作空间")
s.btn(px+48, 330, pw-96, 66, "立即同步")
s.small(px+pw//2, 400, "这一轮走的是：附近的设备 · 2 台可用", INK)
y = 452
s.t(px+24, y, "同步方式", F_S); s.t(px+pw-24, y, "自动（连着服务器时对端一改就拉）  →", F_S, MUT, anchor="ra")
s.row(px+24, y+34, pw-48, "只在 Wi-Fi 下同步", "开")
s.row(px+24, y+98, pw-48, "服务器", "192.168.43.206")
s.row(px+24, y+162, pw-48, "账号", "已登录")
s.line_h = 0
s.d.line([px+24, y+226, px+pw-24, y+226], fill=LINE, width=1)
# ⭐ 进阶 · 收起态（本次重点 ✓）
s.t(px+24, y+248, "进阶", F_S, MUT)
s.card(px+24, y+280, pw-48, 120, fill=GREY)
s.t(px+48, y+318, "空间隐私 · 同步历史 · 同步预算", F_B)
s.small(px+48, y+352, "＋ 设备直连与「附近的设备」都收在这一层里（点开才展开）")
s.small(px+48, y+378, "收起时面板只剩 4 行 ＋ 1 个按钮 —— 这一步是在做减法")
# 右侧注释
nx, nw = px+pw+40, 1180
yy = 176
yy = s.note(nx, yy, nw, ["※ 只画了「免费版」能看到的那些行。",
                          "「立即同步」这一轮若走的是局域网直连，读数行写「附近的设备 · N 台可用」。",
                          "免费版**不承诺跨网络**：跨网络那条要付费档才出现（见第 4 张）。"], "green") + 24
yy = s.note(nx, yy, nw, ["※ 「进阶」这一层是本轮新加的（owner 2026-09-30）。",
                          "旧效果图把「设备直连／本网段」摆在外层 —— 那个口径**已废**。",
                          "现在外层只留：同步方式／只在 Wi-Fi 下同步／服务器／账号。",
                          "「设备直连＋拉取间隔＋附近设备」全部收进「进阶」⇒ 见第 2 张展开态。"], "amber") + 24
s.note(nx, yy, nw, ["⛔ 界面禁用词（旧图里有，本套全部不用）：",
                    "「同网段」「局域网直连」「本网段」——虚拟网段（VPN）下不准确。",
                    "统一改说「附近的设备」（两种情形下都成立）。"], "red")
s.footer(960, [
 "① 免费版＝本地＋局域网直连：`_workspace/notes/2026-09-30-three-tier-requirements-spec.md` §19（owner 2026-09-30 改定）",
 "② 「设备直连／附近设备」收进「进阶」：owner 2026-09-30；界面已落（`SyncPanel.tsx` 的 `sync-group is-advanced`）",
 "③ 界面口径「附近的设备」：`repos/ShuyoNote/docs/plans/2026-09-29-virtual-lan-option.md:73-74`（原文「例如「附近的设备」在两种情形下都成立」）",
 "④ 免费版不承诺跨网络：`repos/ShuyoNote/docs/specs/2026-09-29-personal-edition-requirements.md` U13/U7 边界",
])
s.save("效果图-01-总览-免费版-进阶收起.png")

# ═══════════════════════════ ② 进阶组【展开】
s = Sheet("同步面板 · 进阶组【展开】—— 设备直连 ＋ 拉取间隔 ＋ 附近设备",
          "「设备直连」是总闸的下级开关；关掉它，「拉取间隔」整行不出现（不是灰掉）")
px, pw = 56, 620
s.panel(px, 176, pw, 820, "同步 · 进阶（展开）", "点开「进阶」之后")
y = 252
s.card(px+24, y, pw-48, 150, fill=GREY)
s.t(px+48, y+22, "空间隐私 · 同步历史 · 同步预算", F_S, MUT)
s.t(px+48, y+56, "设备直连（附近的设备互相直连）", F_B)
s.t(px+pw-48, y+56, "开  →", F_S, BLUE, anchor="ra")
s.small(px+48, y+90, "关掉它 ⇒ 「拉取间隔」那一行不出现（没有间隔可谈）")
s.small(px+48, y+116, "它是开关；上面的「同步方式」是总闸 —— 总闸关了它会灰掉")
y += 174
s.card(px+24, y, pw-48, 120, fill=GREY)
s.t(px+48, y+22, "拉取间隔", F_B); s.t(px+pw-48, y+22, "5 秒  →", F_S, BLUE, anchor="ra")
s.small(px+48, y+58, "只对局域网那条路生效（默认 5 秒、可调）")
s.small(px+48, y+84, "节拍越密越快发现对端，也越费电 —— 默认值取的是折中")
y += 144
s.card(px+24, y, pw-48, 300, fill=GREY)
s.t(px+48, y+22, "附近的设备", F_B); s.t(px+pw-48, y+22, "2 台  →", F_S, BLUE, anchor="ra")
for i, (nm, act) in enumerate([("小王的笔记本", "已配对  解除"), ("我的手机", "把这台设备接进来")]):
    ry = y + 62 + i*96
    s.card(px+48, ry, pw-96, 84, edge=LINE, fill=CARD, r=10)
    s.t(px+68, ry+18, nm, F_B); s.small(px+68, ry+48, "附近 · 服务「我的工作空间」")
    if i == 0:
        s.small(px+pw-68, ry+24, "已配对", F_S, GREEN, anchor="ra")
        s.btn(px+pw-170, ry+24, 110, 36, "解除", kind="ghost")
    else:
        s.btn(px+pw-268, ry+24, 208, 36, "把这台设备接进来")
s.small(px+48, y+258, "每台一行、一行一个动作；只写设备名字与「附近 · 服务」")
nx, nw = px+pw+40, 1180
yy = 176
yy = s.note(nx, yy, nw, ["※ 「设备直连」是总闸的下级开关（两态）：",
                          "· 总闸（「同步方式」）关 ⇒ 设备直连那一行**灰掉**（它是开关，总闸关了不可能生效）",
                          "· 设备直连关 ⇒ 「拉取间隔」整行**不出现**（不是灰掉 —— 关了就没有间隔可谈）"], "green") + 24
yy = s.note(nx, yy, nw, ["※ 这一层是本轮**新加**的（owner 2026-09-30）。",
                          "旧效果图把「设备直连／本网段 N 台」摆在外层 —— 那个口径已废。",
                          "现在外层只留 4 行；这三块全部收进「进阶」，点开才见。"], "amber") + 24
s.note(nx, yy, nw, ["※ 配对入口就在这一层：", "「附近的设备」里那台没配对的设备 ⇒ 右侧按钮「把这台设备接进来」",
                     "⇒ 点它就进第 3 张的「配对三步」。"], "blue")
s.footer(1040, [
 "① 「设备直连／附近设备收进进阶」：owner 2026-09-30；界面已落（`SyncPanel.tsx`：`sync-group is-advanced`）",
 "② 两态口径（总闸关⇒灰掉；设备直连关⇒不出现）：`repos/ShuyoNote/docs/specs/2026-09-28-sync-panel-density-requirements.md`",
 "③ 「拉取间隔」默认 5 秒可调：`repos/ShuyoNote/docs/specs/2026-09-29-personal-edition-requirements.md` U7",
 "④ 号码牌不发了（网格原理）：`records/局域网同步原理/局域网同步-原理图.png` ＋ 同名 `.md`",
])
s.save("效果图-02-进阶展开-设备直连与附近设备.png")

# ═══════════════════════════ ③ 配对 · 三步两态（本次核心）
s = Sheet("同步面板 · 配对流程 —— 三步 ＋「停」态",
          "配对＝**比对码**：两端各显示同一串 **20 位**数字，人核对一致再采纳｜⛔ 不做 6 位短码、不许自动通过")
cw, gap = 600, 40
x0 = 56
# 第 1 步
s.card(x0, 176, cw, 560)
s.t(x0+24, 200, "第 1 步 · 在设备 A 上发起", F_B)
s.small(x0+24, 234, "点开「进阶 ⇒ 附近的设备」，那台未配对的设备右侧点一下")
s.btn(x0+48, 274, cw-96, 62, "把这台设备接进来")
s.card(x0+48, 356, cw-96, 120, fill=GREY)
s.t(x0+72, 380, "小王的笔记本", F_B); s.small(x0+72, 410, "附近 · 服务「我的工作空间」")
s.small(x0+72, 438, "右侧动作：把这台设备接进来")
s.note(x0+48, 496, cw-96, ["※ 按钮文案就是「把这台设备接进来」。",
                            "它是**单向授权**：我授权我自己（不等对方同意）。"], "amber")
s.t(x0+48, 610, "⇒ 手机屏幕上出现一串 20 位比对码", F_S)
# 第 2 步
x1 = x0 + cw + gap
s.card(x1, 176, cw, 560)
s.t(x1+24, 200, "第 2 步 · 两端显示同一串比对码，我核", F_B)
s.small(x1+24, 234, "A 与 B 各自的屏幕上一模一样 ⇒ 才能往下走")
for i, nm in enumerate(["设备 A", "设备 B"]):
    bx = x1 + 48 + i*((cw-96)//2 + 0)
    bw = (cw-96)//2 - 12
    s.card(bx, 274, bw, 250, fill=CARD)
    s.t(bx+bw//2, 298, nm, F_B, anchor="ma")
    for j in range(5):
        pass
    s.t(bx+bw//2, 340, "比对码 20 位（必须一样）", F_XS, MUT, anchor="mm")
    s.t(bx+bw//2, 386, "4829 1370", F_S, INK, anchor="mm")
    s.t(bx+bw//2, 418, "5561 2084", F_S, INK, anchor="mm")
    s.t(bx+bw//2, 450, "7713", F_S, INK, anchor="mm")
    s.btn(bx+16, 466, bw-32, 40, "一致，继续", kind="ghost")
s.note(x1+48, 524, cw-96, ["※ 两端码**不一样** ⇒ 停，可能有人在中间。",
                            "（一样才继续 —— 这一眼是这条路上唯一一步防冒充。）"], "amber")
s.note(x1+48, 618, cw-96, ["⛔ 没有这个选项：「我知道这是我的设备，跳过他核对」",
                            "（界面上不提供绕过核对的口子 —— 画面上它不存在。）"], "red")
# 第 3 步
x2 = x1 + cw + gap
s.card(x2, 176, cw, 560)
s.t(x2+24, 200, "第 3 步 · 配对完成", F_B)
s.small(x2+24, 234, "两台各生成一份「设备对秘密」—— 内部材料，界面不显示它的内容")
s.card(x2+48, 274, cw-96, 96, fill=GREEN_BG, edge=GREEN)
s.t(x2+72, 296, "已配对", F_B, GREEN)
s.small(x2+72, 328, "以后自动连接，不用再对码")
s.small(x2+72, 352, "界面只写这一句 —— 不显示任何密钥内容")
s.card(x2+48, 386, cw-96, 110, fill=GREY)
s.t(x2+72, 408, "两端各自随机生成「设备对秘密」并互认", F_S)
s.small(x2+72, 440, "它是**内部材料** —— 界面上不出现它的任何内容")
s.small(x2+72, 466, "好处：**撤销是逐台的** —— 撤一台不动其他台")
s.btn(x2+48, 512, cw-96, 52, "解除配对（只撤这一台）", kind="ghost")
# 「停」态（单独一格）
s.card(x0, 772, cw*3+gap*2, 300, edge=RED, fill=RED_BG)
s.t(x0+24, 796, "「停」态（两端比对码不一致）—— 单独一态，且**没有「继续」**", F_H, RED)
yy = 850
s.card(x0+48, yy, 760, 180, fill=CARD, edge=RED)
s.t(x0+72, yy+20, "比对码不一致", F_B, RED)
s.small(x0+72, yy+56, "设备 A：4829 1370 5561 2084 7713")
s.small(x0+72, yy+86, "设备 B：4829 1370 5561 2094 1180   ← 后段不同")
s.small(x0+72, yy+120, "⇒ 界面进「停」态：只说明不一致，**没有任何「继续」入口**")
s.small(x0+72, yy+146, "⇒ 本机零写入（对不上一律不采纳）")
s.note(x0+840, yy, cw*3+gap*2-888, [
  "※ 为什么「停」态要单独画：它是防冒充的那一眼。",
  "⛔ 界面上**不许**出现「继续／跳过／我知道这是我的设备」这类口子 ——",
  "   变异判据就钉这一条：给「停」态加一个「继续」按钮 ⇒ 组件测必须红。",
  "※ 二维码只是**可选载体**（把这段文本装进去，方便旧设备用系统相机扫）——",
  "   ⛔ **扫码不替代核对**：码长不缩（20 位／60 bit），核对永远是人眼那一眼。"], "red")
s.footer(1110, [
 "① 配对＝比对码、两端显示、人核对一致再采纳；不做 6 位短码：`docs/specs/2026-09-29-nearby-devices-requirements.md:163`",
 "② 码长 20 位／60 bit、不许缩：「核对这一步仍然是人对比对码 —— 扫码不替代核对」（`2026-09-29-nearby-devices-spec.md:1268`）",
 "③ 两端码不一致 ⇒ 停、且界面无「继续」：`docs/specs/2026-09-29-personal-edition-approach.md` 承重判据 ②③（变异：加「继续」⇒ 必须红）",
 "④ 配对路径没有「等对方同意」这一步：`INV-PER-pairing-needs-no-acceptance`（同上，承重判据 ③）",
])
s.save("效果图-03-配对三步与停态.png")

print("batch 1 done（①②③）")
# ═══════════════════════════ ④ 个人版 · 付费 —— 跨网络同步
s = Sheet("同步面板 · 个人版（付费）—— 跨网络同步（中继由你自己架）",
          "口径：付费档才出现跨网络同步｜中继由用户自己部署、只做穿透不存数据｜面板不写价格")
px, pw = 56, 620
s.panel(px, 176, pw, 620, "同步 · 已订阅", "到期时间：2027-10-01（到期前会提示续订）")
s.t(px+24, 262, "已订阅", F_H, GREEN)
s.small(px+24, 310, "这一轮走的是：跨网络（经你自己的中继） · 2 台设备可用")
y = 356
s.row(px+24, y, pw-48, "传输", "跨网络（iroh 直连优先，打不通走中继）  →")
s.row(px+24, y+64, pw-48, "中继", "可达（你自己那台）  →", value_fill=GREEN)
s.row(px+24, y+128, pw-48, "服务端", "不提供（本档没有服务端）")
s.note(px+48, y+206, pw-96, ["※ 本档只有「中继」这一件基础设施，而且是你的。",
                             "它只做穿透、不存数据；内容端到端加密。"], "green")
nx, nw = px+pw+40, 1180
yy = s.note(nx, 176, nw, ["※ 什么时候会走中继：两台设备不在同一个网络、直连打不通时。",
                          "直连优先仍成立 —— 能直连就不占中继。"], "green") + 24
yy = s.note(nx, yy, nw, ["※ 中继不可达时会怎样（这一格必须画，用户最常撞）：",
                         "· 退化为「附近的设备」：同一个网络内仍能自动同步；",
                         "· 跨网络那几台这次同步不上，界面如实说「中继不可达」，不假装成功。"], "amber") + 24
s.note(nx, yy, nw, ["※ 面板不写价格：定价在官网（月 15 元 / 年 99 元 / 首年限时 58 元）。",
                    "面板只写「已订阅 / 到期时间」——价格写进界面会立刻过期。"], "blue")
s.footer(860, [
 "① 免费版给「附近的设备」、付费档才给跨网络：`_workspace/notes/2026-09-30-three-tier-requirements-spec.md` §19",
 "② 中继由用户自己部署、我们只给技术支持：同上 §4 的 P4",
 "③ 中继只做穿透、不存数据（端到端加密）：同上 §4 的 P2",
 "④ 许可绑中继实例 ＋ 到期续费：同上 §13（停付 → 到期 → 中继停服）",
])
s.save("效果图-04-付费跨网络同步.png")

# ═══════════════════════════ ⑤ 企业版 —— iroh 默认 / HTTPS 可选 / 自动回退
s = Sheet("同步面板 · 企业版 —— iroh 默认、HTTPS 可选、自动回退",
          "口径：服务端与 iroh relay 各自独立部署（通常不同台）｜数据一步不出客户边界")
px, pw = 56, 620
s.panel(px, 176, pw, 660, "同步 · 企业版", "客户自己的同步服务端 ＋ 客户自己的 iroh relay")
s.t(px+24, 258, "传输方式", F_S)
s.card(px+24, 288, pw-48, 96, fill=GREEN_BG, edge=GREEN)
s.t(px+48, 308, "iroh（默认）", F_B, GREEN); s.small(px+48, 342, "打不通就自动回退到 HTTPS，不用用户手动切")
s.card(px+24, 396, pw-48, 96)
s.t(px+48, 416, "HTTPS（可选）", F_B); s.small(px+48, 450, "内网禁 UDP 时的退路；这一条不许退化")
s.note(px+24, 512, pw-48, ["※ 「自动回退」是硬要求：内网禁 UDP 时要能自己走 HTTPS。",
                           "※ 信创 / 国密档见第 6 张：那一档纯 HTTPS。"], "amber")
nx, nw = px+pw+40, 1180
yy = s.note(nx, 176, nw, ["※ 两台机器，不是一台（这是本轮更正的口径）：",
                          "· 同步服务端（存储 / 账本 / 权限）—— 客户自己的；",
                          "· iroh relay（只做 NAT 穿透）—— 通常**另外一台**。",
                          "旧图把两者画成同一台 —— 那个口径已废。"], "green") + 24
yy = s.note(nx, yy, nw, ["※ 数据一步不出客户边界：relay 与服务端都在客户侧；",
                         "不接 n0、不接第三方 DNS。"], "green") + 24
s.note(nx, yy, nw, ["※ 部署前置（写进交付文档）：relay 那台需要**公信证书**。",
                    "没有公网域名 / 证书时，relay 走不通，只能退化为直连。"], "amber")
s.footer(900, [
 "① iroh 默认 ＋ HTTPS 可选 ＋ 自动回退：`_workspace/notes/2026-09-30-three-tier-requirements-spec.md` §5 的 E1 / E2",
 "② 服务端与 iroh relay 各自独立部署（通常不同台）：同上 E3（owner 2026-09-30 更正）",
 "③ 数据不出客户边界：同上 §5 的 E4；relay 需公信证书：E5",
 "④ 信创 / 国密档纯 HTTPS（无 iroh）：同上 E6",
])
s.save("效果图-05-企业版-iroh默认与自动回退.png")

# ═══════════════════════════ ⑥ 信创 / 国密档 —— 纯 HTTPS
s = Sheet("同步面板 · 信创 / 国密档 —— 纯 HTTPS（没有 iroh）",
          "口径：这一档传输只有 HTTPS｜国密应用层默认开（SM4-CBC ＋ HMAC-SM3）｜库级默认关、对拍未验")
px, pw = 56, 620
s.panel(px, 176, pw, 620, "同步 · 信创档", "传输只有 HTTPS；构建里不含 iroh")
s.t(px+24, 258, "传输方式", F_S)
s.card(px+24, 288, pw-48, 96, fill=BLUE_BG, edge=BLUE)
s.t(px+48, 308, "HTTPS（唯一路径）", F_B, BLUE); s.small(px+48, 342, "本档不提供 iroh，也不接受自动回退到它")
s.t(px+24, 406, "加密", F_S)
s.row(px+24, 436, pw-48, "应用层国密", "开（SM4-CBC ＋ HMAC-SM3）  →", value_fill=GREEN, top=False)
s.row(px+24, 500, pw-48, "库级国密（磁盘页）", "默认关（要显式打开）")
s.note(px+24, 580, pw-48, ["※ 应用层是纯 Rust（全平台同一份实现）；库级要 Tongsuo 后端。",
                           "※ 库级的对拍（与 Tongsuo 双向）目前 CI 没装 ⇒ 如实自报跳过。"], "amber")
nx, nw = px+pw+40, 1180
yy = s.note(nx, 176, nw, ["※ 为什么这一档没有 iroh：信创 / 密评要国密算法，",
                          "  而 iroh 走 QUIC / TLS1.3（国际算法）。",
                          "  ⇒ 建议这一档**编译期就不带 iroh**（feature gate），",
                          "     交付物里根本不含国际算法组件。"], "green") + 24
s.note(nx, yy, nw, ["※ 诚实标注（别让客户以为都验过了）：",
                    "· 应用层国密：已默认打开（纯 Rust、全平台一致）；",
                    "· 库级国密：接缝就位但**默认关**；",
                    "· 与 Tongsuo 的对拍：**没验过**（CI 没装 Tongsuo ⇒ 门禁如实自报跳过）。"], "red")
s.footer(860, [
 "① 信创 / 国密档纯 HTTPS（无 iroh）：`_workspace/notes/2026-09-30-three-tier-requirements-spec.md` §5 的 E6",
 "② 应用层国密默认开：`repos/ShuyoNote/src-tauri/Cargo.toml` 的 `default = [\"sm-crypto\"]`",
 "③ 库级默认关 ＋ 要显式 OPENSSL_DIR：同文件 `sm-library` 注释",
 "④ 对拍未验（CI 无 Tongsuo、门禁自报跳过）：`repos/ShuyoNote/scripts/lib/gates.mjs` 的 gm-conformance 注释",
])
s.save("效果图-06-信创国密档-纯HTTPS.png")

# ═══════════════════════════ ⑦ 加密档（按空间）＋ 团队组织与审计
s = Sheet("同步面板 · 加密档（按空间）＋ 团队组织与审计",
          "口径：加密开关按空间生效｜未加密标记在空间上常驻｜组织 / 成员 / 角色 / 审计属团队档")
px, pw = 56, 620
s.panel(px, 176, pw, 660, "空间隐私 · 团队", "每个空间各自决定是否加密")
s.t(px+24, 258, "我的工作空间", F_B)
s.card(px+24, 288, pw-48, 100, fill=GREEN_BG, edge=GREEN)
s.t(px+48, 308, "已加密", F_B, GREEN); s.small(px+48, 342, "服务端只拿得到密文；钥匙只在设备上")
s.t(px+24, 414, "课题组共享空间", F_B)
s.card(px+24, 444, pw-48, 100, fill=AMBER_BG, edge=AMBER)
s.t(px+48, 464, "未加密（标记常驻）", F_B, AMBER); s.small(px+48, 498, "服务端读得到明文 —— 换来协同 / 检索 / AI")
s.note(px+24, 566, pw-48, ["※ 加密是**按空间**的：同一个客户端里两个空间可以一密一明。",
                           "※ 未加密那档的标记**常驻**，不是只在设置里提一次。"], "amber")
nx, nw = px+pw+40, 1180
yy = s.note(nx, 176, nw, ["※ 团队档的界面（与个人版不同的三块）：",
                          "· 组织管理：组长建组织、按邮箱开通成员、停用 / 启用；",
                          "· 成员与角色权限：两级角色 ＋ 团队空间；",
                          "· 审计日志：谁拉过什么（个人版没有这一块）。"], "green") + 24
s.note(nx, yy, nw, ["※ 边界写清楚（别让用户以为加密＝什么都看不见）：",
                    "· 加密空间：服务端只拿密文、也**不做**服务端检索 / 审核；",
                    "· 未加密空间：明文上传，且**已上传的明文收不回来。**"], "amber")
s.footer(900, [
 "① 加密开关按空间生效（2026-09-24 已实现）：`repos/ShuyoNote/docs/sync-server-data-boundary.md:57-59`",
 "② 未加密标记常驻：同上 ＋ `_workspace/notes/2026-09-28-optional-encryption-and-warnings.md`",
 "③ 团队档三块（组织 / 角色 / 审计）：`repos/ShuyoNote/docs/specs/2026-09-29-enterprise-edition-requirements.md`",
 "④ 加密空间不做服务端检索 / 审核：`INV-ENT-dumb-relay-not-understanding`（服务端不解析 payload）",
])
s.save("效果图-07-加密档与团队组织审计.png")

# ═══════════════════════════ ⑧ 空间与服务器（只有【团队空间】绑服务器；【个人空间】没有服务器）
#   ⚠️ 2026-10-01 两次改口径后重画 ✗：
#      · 原图画「个人空间 → 自己那台（B）」✗ ⇒ 与 §23②「个人空间不能绑定服务器」冲突 ✓
#      · 本轮加 §25「可绑多台，但同一时间只有一台【活动】＝当前组织」✓ ⇒
#        ⭐ 要标出【当前组织】＋ ⚠️ 不在当前组织下的团队空间显示「未在当前组织下 · 暂停同步」✓
s = Sheet("同步面板 · 空间与服务器 —— 只有【团队空间】绑服务器 · 【个人空间】没有服务器",
          "口径：① 创建空间只让选两类 ｜ ② 个人空间不能绑服务器 ｜ ③ 团队空间可在同步面板绑服务器 ｜ "
          "④ 个人空间同步只有三条路 ｜ ⑤ 可绑多台，但同一时间只有一台【活动】＝当前组织")
px, pw = 56, 900
s.panel(px, 176, pw, 680, "空间与服务器",
        "本机已登录 2 台服务器；【当前组织】＝公司服务器 A —— 只有团队空间在连")
y = 262
s.row(px+24, y,      pw-48, "工作空间（团队空间）", "公司服务器（A） · 当前组织", h=58, value_fill=GREEN)
s.row(px+24, y+58,   pw-48, "学习空间（团队空间）", "公司服务器（A） · 当前组织", h=58, value_fill=GREEN)
s.row(px+24, y+116,  pw-48, "研发空间（团队空间）", "自己那台（B）｜未在当前组织下 · 暂停同步", h=58, value_fill=AMBER)
s.row(px+24, y+174,  pw-48, "个人空间", "不经服务器（没有服务器，也绑不了）", h=58, value_fill=RED, arrow=False)
s.small(px+24, y+252, "个人空间没有服务器 → 它的同步手段只有三条：")
s.small(px+24, y+282, "· 设备直连（局域网）    · 中继服务（付费）    · 手工拷贝")
s.card(px+24, y+318, pw-48, 92, fill=GREEN_BG, edge=GREEN)
s.t(px+48, y+334, "【当前组织】＝公司服务器 A", F_B, GREEN)
s.small(px+48, y+370, "切换当前组织在「设置 · 账户」（一键，不用重新登录）—— 同一时间只有一台在同步")
s.small(px+24, y+444, "【注意】换服务器会重置同步游标：last_pushed_seq / last_pulled_seq")
s.small(px+24, y+472, "是按旧服务器的权威序记的 → 换后失效，必须重新对齐（先全量拉一次）。")
s.btn(px+24, y+526, 240, 56, "更换服务器", "ghost")
s.small(px+288, y+554, "· 只有团队空间有这一行；个人空间没有「更换服务器」。")
s.small(px+288, y+582, "· 也没有「再加一台」这个按钮（那等于两个「谁更新」的说法）。")
nx, nw = px+pw+40, 944
yy = s.note(nx, 176, nw, ["· 【团队空间】一个空间 → 一台服务器：本行只显示一台；要换只能点「更换服务器」。",
                          "  三行各是一行，互不影响 —— 换其中一个，不会动到另外两个。"], "green") + 24
yy = s.note(nx, yy, nw, ["· 多空间可指同一台：工作空间与学习空间都指 A（都是团队空间）。",
                         "  同一条服务器地址出现在两行里，两行仍各自独立记自己的游标。"], "blue") + 24
yy = s.note(nx, yy, nw, ["· 个人空间没有服务器：它不显示服务器，也绑不了服务器（owner 2026-10-01）。",
                         "  它的同步手段只有三条：设备直连（局域网）／中继服务（付费）／手工拷贝。"], "purple") + 24
yy = s.note(nx, yy, nw, ["· 【当前组织】只有一台（owner 2026-10-01：可绑多台，但同时只有一台活动）。",
                         "  · 研发空间还在 B 上 → 它不在当前组织下 ⇒ 必须显示「暂停同步」。"], "amber") + 24
s.note(nx, yy, nw, ["【禁】同一个【团队空间】同时绑两台 → 两个「谁更新」的说法。",
                    "权威序（服务端 seq）只能由一处发 —— 两个源就会乱序 / 冲突。"], "red")
s.footer(900, [
 "① 空间类型与「能不能绑服务器」（① 只让选两类 ② 个人空间不能绑 ③ 团队空间可绑）：`_workspace/notes/2026-09-30-three-tier-requirements-spec.md` §23",
 "② 三档的同步手段矩阵（个人空间：设备直连 / 中继服务 / 手工拷贝；团队空间另有服务器）：同上 §24",
 "③ 更换服务器会重置同步游标（last_pushed_seq / last_pulled_seq 按旧服务器权威序记）：同上 §22.1（§22 只谈团队空间）",
 "④ 多服务器三条（一空间一台 / 多空间可指同一台 / 一设备可多台）：同上 §22（已限定为团队空间）",
 "⑤ 【当前组织】＋「不许静默停更」（不在当前组织下 ⇒ 显示「暂停同步」，不是「已同步」）：同上 §25",
 "⑥ 代码事实：`'personal'` 现在是「必须按空间加密后才允许绑定同步」→ 按新口径要改成「一律不许」：`repos/ShuyoNote/src-tauri/src/db.rs:334`",
 "⑦ 按空间绑远端、主键是 ws_id（不是 server_url）：`repos/ShuyoNote/src-tauri/src/db.rs:340-344`",
])
s.save("效果图-08-空间与服务器-只有团队空间绑服务器.png")

# ═══════════════════════════ ⑨ 分工 · 同步面板（空间级）—— 左右两栏：个人空间 / 团队空间
#   ⚠️ 2026-10-01 owner 抓到的真缺口 ✗：原图**只画了团队空间** ✓，
#      而**免费版用户看到的其实是个人空间那一套** ✓（那是产品主路径）⇒
#      ⭐ 改成**一张图左右两栏** ✓：判据＝一眼看出「同一个面板，两种空间长得不一样」✓
s = Sheet("分工 · 【同步面板】—— 空间级：这个空间现在怎么同步",
          "总判据：账号是设备级的，同步是空间级的 ｜ 同一个面板，两种空间长得不一样")
# —— 左栏：个人空间（免费版主路径；没有服务器）
lx, lw = 56, 900
s.panel(lx, 176, lw, 480, "① 个人空间（免费版的主路径）",
        "没有服务器 → 这一栏不出现「服务器 / 空间 ID / 登录」")
s.row(lx+24, 262, lw-48, "同步方式", "开（可关 / 仅设备直连）", value_fill=GREEN, arrow=False)
s.small(lx+24, 344, "① 设备直连（局域网）—— 同一网段两两直连，不经服务器")
s.small(lx+24, 376, "② 附近的设备 —— 含【配对】入口（三步两态：发起 / 两端比对同一串")
s.small(lx+24, 406, "   20 位码 / 采纳；不一致就停，且没有「继续」）")
s.small(lx+24, 438, "③ 中继服务（付费才有）—— 跨网络走你自己的中继")
s.small(lx+24, 470, "④ 手工拷贝 —— 导出 / 导入（跨网络手动搬家）")
s.card(lx+24, 508, lw-48, 74, fill=RED_BG, edge=RED)
s.t(lx+48, 524, "【硬约束】个人空间没有服务器，也绑不了服务器", F_B, RED)
s.small(lx+48, 556, "所以这里没有「服务器 / 空间 ID / 登录」那一套（§23② / §24）")
s.small(lx+24, 604, "付费档也只是多一条「中继服务」—— 仍然没有服务器。")
# —— 右栏：团队空间（保留原来那套）
rx, rw = 996, 944
s.panel(rx, 176, rw, 480, "② 团队空间（可绑服务器）",
        "当前空间：研发空间 · 所属服务器：公司服务器（A） · 当前组织")
s.row(rx+24, 262, rw-48, "服务器", "公司服务器（A） →", value_fill=GREEN)
s.row(rx+24, 326, rw-48, "空间 ID", "rd-2026-q4 →")
s.row(rx+24, 390, rw-48, "登录状态", "已登录（就地登录拿到的令牌）", value_fill=GREEN, arrow=False)
s.btn(rx+24, 486, 240, 56, "就地登录", "primary")
s.btn(rx+288, 486, 260, 56, "解绑这个空间", "ghost")
s.small(rx+24, 566, "【已定】解绑后本地数据留着 —— 本地照常用，只是不再同步；")
s.small(rx+24, 596, "不删数据（要删是另一个动作 ＋ 二次确认）。解绑后显示「已解绑 · 本地 · 不参与同步」。")
# —— 下方两栏说明
s.note(56, 684, 900, ["※ 这一页管什么（空间级）：这个空间绑哪台服务器、走什么路、现在能不能同步。"], "green")
s.note(996, 684, 944, ["※ 【为什么】「退出登录」不在这一页 —— 它是设备级的：",
                       "  一次会影响那台服务器下所有团队空间，不只这一个。",
                       "  → 放在「设置 · 账户」，而且退出前会列出影响面。"], "amber")
s.note(56, 786, 1884, ["※ 四种状态不许互相伪装：",
                       "  · 已同步 ／ · 登录已过期 · 重新登录 ／ · 未在当前组织下 · 暂停同步 ／ · 本地 · 不参与同步"], "red")
s.footer(900, [
 "① 分工总判据（账号设备级 / 同步空间级）＋ 解绑保留本地数据：`_workspace/notes/2026-09-30-three-tier-requirements-spec.md` §26",
 "② 就地登录 ⇒ 同步面板；退出登录 ⇒ 设置 · 账户（设备级）：同上 §26.2",
 "③ 四种状态不许互相伪装 ＋ 退出前列影响面：同上 §26.3",
 "④ 【当前组织】只有一台、不在当前组织下显示「暂停同步」：同上 §25",
 "⑤ 个人空间的三条同步路（设备直连 / 中继服务（付费）/ 手工拷贝）＋ 没有服务器：同上 §23② / §24",
 "⑥ 配对＝比对码（两端各显示同一串 20 位、人核对一致再采纳；不一致就停）：本目录 `效果图-03-配对三步与停态.png`",
])
s.save("效果图-09-同步面板-空间级.png")

# ═══════════════════════════ ⑩ 分工 · 设置 · 账户（设备级）
s = Sheet("分工 · 【设置 · 账户】—— 设备级：我是谁",
          "已登录的服务器清单 ＋ 当前组织 ＋ 一键切换 ｜ ⛔ 这一页不出现「这个空间绑哪台」")
px, pw = 56, 620
s.panel(px, 176, pw, 700, "账户与服务器", "本机已登录 2 台服务器")
s.card(px+24, 262, pw-48, 104, fill=GREEN_BG, edge=GREEN)
s.t(px+48, 282, "公司服务器（A）", F_B, GREEN)
s.small(px+48, 316, "【当前组织】· 3 个团队空间在同步")
s.card(px+24, 382, pw-48, 104)
s.t(px+48, 402, "自己那台（B）", F_B)
s.small(px+48, 436, "已登录 · 非当前 · 1 个团队空间暂停同步")
s.btn(px+24, 508, 200, 56, "设为当前", "ghost")
s.btn(px+248, 508, 220, 56, "退出登录", "primary")
s.note(px+24, 590, pw-48, ["※ 退出登录前会列出影响面（不许静默）：",
                           "  「这会让 3 个团队空间停止同步」"], "amber")
s.btn(px+24, 700, 280, 56, "注销账号（危险）", "ghost")
s.small(px+320, 728, "代码逐字：数据已转交组长。")
nx, nw = px+pw+40, 1180
yy = s.note(nx, 176, nw, ["※ 这一页管什么（设备级）：我是谁、登了哪几台、哪台是【当前组织】。"], "green") + 24
yy = s.note(nx, yy, nw, ["※ 一键切换「当前服务器」：可绑多台，但同一时间只有一台在同步（owner 2026-10-01）。",
                         "  切走之后，另一台的团队空间显示「未在当前组织下 · 暂停同步」。"], "blue") + 24
yy = s.note(nx, yy, nw, ["※ 退出登录是设备级的：会一次影响那台服务器下所有团队空间 —— 所以放在这一页。"], "amber") + 24
yy = s.note(nx, yy, nw, ["※ 四种状态（与同步面板同一套，不许互相伪装）：",
                         "  · 已同步 ／ · 登录已过期 · 重新登录",
                         "  · 未在当前组织下 · 暂停同步 ／ · 本地 · 不参与同步"], "red") + 24
s.note(nx, yy, nw, ["【禁】这一页不出现「这个空间绑哪台」—— 那是空间级的事，在同步面板。"], "red")
s.footer(900, [
 "① 分工总判据（账号设备级 / 同步空间级）：`_workspace/notes/2026-09-30-three-tier-requirements-spec.md` §26",
 "② 动作归属：退出登录 / 注销 / 切换当前服务器 ⇒ 设置 · 账户：同上 §26.2",
 "③ 【当前组织】只有一台（可绑多台、同时一台活动）：同上 §25",
 "④ 注销账号代码逐字「数据已转交组长」：`repos/ShuyoNote/src/components/SettingsDialog.tsx:757`",
 "⑤ 现状要改：server_url 两边都有（SyncPanel 38 处 / SettingsDialog 12 处）⇒ 按分工收敛：同上 §26.4",
])
s.save("效果图-10-设置账户-设备级.png")

print("batch 4 done（⑧改 ＋ ⑨⑩）—— 成套 10 张")

# ⭐ 字形闸门收口：任何一张缺字形 ⇒ **非零退出** ✓（"不许静默出方框" ✗）
if ALL_BAD:
    raise SystemExit("\n".join(["⛔ 有 %d 张缺字形（方框）：" % len(ALL_BAD)] +
                               ["   · %s ⇒ %s" % (n, " ".join(b)) for n, b in ALL_BAD] +
                               ["   ⇒ 换字体或改文案；**不要**提交带方框的图 ✗"]))
print("字形闸门：10/10 干净 ✓")
