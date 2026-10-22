# 移动屏「回家的路」一览（谁靠什么回首页）

> **判据**：`node scripts/check-mobile-exit-routes.mjs`（门禁 id `check-mobile-exit-routes`，挂 `contract` 组）
>
> 规矩一句话：**每个移动屏都必须有 ≥1 条机械可认的回家路**。没有 ⇒ 红。
> 为什么有这条：2026-10-10 出过一次**真死路**（台账 R188 的 (b)）—— 快速记录存完落进编辑器，
> 而那个屏按返回键**直接退出应用**、`am start` 重启**仍回编辑器**、抽屉里**没有「首页」** ⇒
> 除 `pm clear` 没有回家的路。当时的补救是在 `App.tsx` 加一颗 `position: fixed` 的「‹ 首页」浮标，
> 那等于**给所有屏兜底** ⇒ 谁漏了都看不出来。2026-10-22 owner 拍板删掉浮标（两条真路已建好），
> **前提就是本判据先存在**。

## 一、今天的表（`node scripts/check-mobile-exit-routes.mjs` 的输出，逐字）

| 屏 | 回家的路 |
|---|---|
| `MobileAbout` | 返回键（`aria-label="返回…"` 或 `m*-back` 类） |
| `MobileCapture` | 屏内显式（`setScreen("home")` / `goHome` / `closeSettings`） |
| `MobilePair` | 返回键 |
| `MobilePairCode` | 返回键 |
| `MobileRead` | 屏内显式（顶栏「‹ 阅读」→ `goHome`） |
| `MobileSearch` | 屏内显式 |
| `MobileSettings` | 底栏三格（被 `App.tsx` 的 `wrapMobile(...)` 包着） |

**不算屏的三个**（判据里显式排除，每个都写了理由）：

| 文件 | 为什么不是屏 |
|---|---|
| `MobileHome` | 首页**本身** —— 它就是目的地 |
| `MobileTabBar` | 底栏**本身**（导航条）—— 它是路，不是屏 |
| `MobileDictCard` | **卡片**（压在阅读屏上的词条卡，`06-dict.svg`） |
| `MobileMergeHistory` | **未接线原型**（没有任何入口渲染它）—— 接线那天要从排除表挪出去 |

## 二、判据认哪三种写法（满足任一即可）

```
① 被 App.tsx 的 wrapMobile(<屏 />) 包着  ⇒ 底栏三格在它上面
② 源码里有 setScreen("home") / goHome / closeSettings
③ 源码里有返回键：aria-label="返回…" 或 className="m*-back"
```

**例外**只能进 `EXEMPT` 白名单（带 `why`），且必须同步改 `EXEMPT_EXPECTED`（今天是 `0`）——
棘轮：⛔ 不许悄悄加一条豁免。

## 三、这条判据**不**管什么（别把它读大）

- ⛔ **不**证明"真的点得到" —— 那是 `scripts/verify-mobile-*.mjs` 那套真实 Chromium 的活；
- ⛔ **不**管底栏是不是被 CSS 藏起来了、返回键是不是被浮层盖住了；
- ⛔ **不**管"按安卓返回键会退出应用"这类**行为**（那条在 `verify-mobile-overlays.mjs` 的返回栈验收里）。

⇒ 它是**源**层的一道闸：**意图**必须有；**效果**由那套浏览器验收负责。
两层都绿才叫"回得去"。
