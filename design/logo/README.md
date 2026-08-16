# ShuyoNote Logo

ShuyoNote 的应用标识。设计语言延续「内容优先、克制的色彩」——品牌蓝 `#3370FF` 做焦点，白色图形做主体。

## 设计概念

**「翻开的笔记」** —— 两页摊开的笔记纸，中间留出一道书脊空隙；每页三条正文行呼应「写作 / 记录」。

右上角的**四角星**是一点「灵感火花」，也暗合品牌名首字母 **S** 的笔画走向（Shuyo → S）。

| 元素 | 含义 |
|------|------|
| 两页纸 | 笔记 / 知识 / 书写 |
| 三条正文行 | 记录、排版、块编辑器 |
| 四角星 | 灵感、灵感火花，S 的意象 |
| 品牌蓝渐变 | 焦点与行动（`#4D8DFF → #2952CC`） |

## 文件

| 文件 | 用途 |
|------|------|
| [`shuyonote-mark.svg`](./shuyonote-mark.svg) | **应用图标**（1024×1024，蓝色渐变底 + 白色图形） |
| [`shuyonote-glyph.svg`](./shuyonote-glyph.svg) | **单色图形**（透明底、品牌蓝，用于浅色界面 / favicon / 水印） |
| [`shuyonote-wordmark.svg`](./shuyonote-wordmark.svg) | **横向组合**（图标 + 「ShuyoNote」字标） |
| [`app-icon.png`](./app-icon.png) | **1024×1024 主图**（由 mark 栅格化，作为 `tauri icon` 的输入源） |

## 色彩规格

| 角色 | 色值 |
|------|------|
| 品牌主色 | `#3370FF` |
| 图标渐变（亮） | `#4D8DFF` |
| 图标渐变（深） | `#2952CC` |
| 正文行（图标内） | `#C7D6FF` |
| 字标「Shuyo」 | `#1F2329` |
| 字标「Note」 | `#3370FF` |

> 与设计系统的 `--accent / --accent-strong / --accent-soft` 保持一致（见 `design/design-system.md`）。

## 使用规范

- **最小尺寸**：图标不低于 16px（favicon）或 32px（工具栏）；小于该尺寸时改用 `shuyonote-glyph.svg` 的单色版。
- **留白**：图标四周保留约 10% 的安全边距（squircle 圆角已内建）。
- **背景**：优先使用蓝色渐变底版（`mark`）；在非蓝色背景或浅色界面上使用单色版（`glyph`）。
- **深色模式**：单色 `glyph` 可将图形反白（`#FFFFFF`）使用；渐变底 `mark` 无需调整。
- **不要**：拉伸变形、改变配色、给图形加描边或投影、把四角星移除或放大。

## 生成图标（Tauri）

```bash
# 修改设计后，重新从 mark 导出 1024×1024 主图（覆盖 design/logo/app-icon.png），
# 然后生成全套图标（Windows ICO / macOS ICNS / iOS / Android / PNG 各尺寸）：
pnpm tauri icon design/logo/app-icon.png
```

生成的图标写入 `src-tauri/icons/`。
