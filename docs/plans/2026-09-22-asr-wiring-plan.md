# ASR 接线：形态与判据（2026-09-22，AMD 认领；owner 选「甲」）

> 由来：`2026-09-22-ai-coverage-readings-and-asr-gap.md` —— 实测**ASR 有模型、仓库零消费者**
> （全仓前端＋Rust 搜 `audio/transcriptions`/`paraformer`/`funasr`/`whisper`/`ASR`/`语音识别`/`录音转写`
> 只命中 `src/lib/ai/types.ts:28` 一行注释）。本文件先把**形态与判据**钉住，再写代码。

## 1. 现状读数（可复跑）

```text
$ vitest run src/lib/ai src/lib/extract          # 含 .live. 两条，走本机模型服务
  Tests 294 passed | 0 failed | 1 skipped (295)   exit=0   72.6s

端点：GET http://127.0.0.1:8080/v1/models ⇒ 9 个；ASR 两个：
  · funasr-nano                        （带标点）
  · sherpa-onnx-paraformer-zh-small    （裸文本，79.5 MB，2026-09-22 装）
闭环冒烟（TTS→ASR）：「今天天气不错，我们下午三点开会。」⇒
  funasr-nano: 今天天气不错，我们下午三点开会。   ← 带标点、逐字一致
  paraformer : 今天天气不错我们下午三点开会       ← 只差逗号
```

## 2. 形态（初稿；入口待 mac 定 —— `llm.ts`／AI 面板是他的地盘）

```
音频/录音文件
  → [提取层] 音频元信息（容器/时长/采样率，纯读，不要解码）
  → [AI 层] POST /v1/audio/transcriptions  { file, model }
  → [归一] 结果 → 纯文本（+ 段/句切分，如果有）
  → [写路径] 进**文档内容层**（照我们的纪律走委派，不自建第二份派生实现）
  → 复用既有【索引 → 分块 → 总结】链（不新造一套）
```

**默认模型**：`funasr-nano`（带标点，更适合进正文）。`sherpa-onnx-paraformer-zh-small` 作轻量/无标点备选。
⚠️ 两者差别**只在标点**（同音频实测内容逐字一致）—— 所以**标点不能成为下游的隐式依赖**：
归一函数必须**显式**声明"这段文本是否含标点"，别让"有没有标点"取决于选了哪个模型。

## 2.5 ★ 冻结契约里**已经有这一格**（2026-09-22 复核 `src/lib/extract/types.ts`）

`types.ts`（冻结 v1，方案 §15）里 **早就为音视频转写留了位置** —— 所以这件事**不是新造形状**，是**填空**：

```ts
export type SegmentKind = … | "transcript";   // 音视频转写：loc = 'HH:MM:SS'
export type ExtractErrorCode = … | "provider_error";   // VLM/ASR 端点不可达或未配置
```

⇒ 我上面对"归一"的设想要按契约收敛成：

- 产物是 **`ExtractedSegment{ kind: "transcript", loc: "HH:MM:SS", text }`**（**`loc` 用时间戳**，
  不是行号 —— 这是转写与其它抽取器最本质的区别：**定位来自音频时间轴**）；
- 端点不可达／没配 ⇒ 返回 **`fail("provider_error", …)`**（**不抛异常**，契约要求）；
- ★ 契约里还有一条硬纪律：**"网络只经注入的 `deps`，不自建客户端"**（守"默认不出网"的红线）
  ⇒ ASR 的端点也必须从**注入点**拿（下一步要先读 `deps` 接口，确认 ASR 是复用 `deps.vision`
  还是需要新增一个注入点 —— **这是写代码前必须先定的一格**，别自己起一个 `fetch`）；
- 算力档位（`ExtractCost`：`cpu`/`gpu`）大概率为 **`gpu`**（要和 VLM／嵌入排队错峰）。

⚠️ 因此**"加一个抽取器"是 gate 耦合的改动**（我读了目录，这条链有 5+ 个文件会被牵动）：
`src/lib/extract/audio.ts`（新）＋ **`registry.ts`**（登记）＋ **`depsCatalog.ts`**（能力目录，且有 `depsCatalog.test.ts`）
＋ **`docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15`**（契约文档的那张矩阵）
＋ `conformance.test.ts` / `coverage.test.ts` / `registry.test.ts` 这几条一致性判据。
⇒ **半截落地会直接把门禁弄红**，所以下一轮按这 6 处**一次做齐**，不自作主张只加一个模块。

## 2.6 ★ 注入点定了：**新增一个可选 `transcribe`**（不蹭 `vision`）—— 2026-09-22 读 `ExtractDeps` 后定

契约现状（`types.ts:70-90`）：`ExtractDeps = { vision?, rasterize? }` —— **没有 ASR 的口子**。
三条不变量必须照办：**全部可选**（没注入 ⇒ 抽取器返回 `provider_error`，**不许抛**、**不许自建网络客户端**）、
**只能由平台层那个唯一入口构造**、抽取层**禁止 import `platform/**`**（有源码级断言 `isolated.test.ts` 守着）。
（顺带印证：`loc` 的示例里早就写着 `'00:03:21'` —— 转写的时间戳定位也是**契约里预留过的**。）

**拟新增**（写在 `ExtractDeps` 里，与 `vision`/`rasterize` 同形）：

```ts
/** 语音转写（音视频 → 文本）。**由平台层注入**；未注入 ⇒ `audio.asr` 返回 `provider_error`。 */
transcribe?: (
  audio: Uint8Array,
  mime: string,
  opts: { model?: string; language?: string },
) => Promise<{ text: string; segments?: readonly { start: number; end: number; text: string }[] }>;
```

**为什么不蹭 `vision`**（设计决定，写下来免得后人"顺手复用"）：
1. 形状不同：`vision(prompt, image, mime)` 是"提问 + 图"；转写是"音频 + 模型 + 语言" ——
   硬塞进去会让**假实现**（判据依赖的那层）与平台接线同时变糊；
2. 契约本来就是**一个能力一个键**（`vision` / `rasterize` 各自带"没注入就 `provider_error`"的规则），
   加 `transcribe` 是**照既有形状填空**，不是发明新规矩；
3. `hasPunct` **不放进 deps 的返回**：由**归一函数**从文本判定（§2 那条口径：标点不能成为隐式依赖）。

⚠️ **跨归属的一格**：`transcribe` 的**实装**在平台层（`src/lib/platform/**` 的那个唯一入口
`attachmentDeps(...)`）—— 那不是我的文件。**我出契约与抽取器；平台侧接线请 mac/windows 认领**
（端点就一条：`POST 127.0.0.1:8080/v1/audio/transcriptions`；两条 curl 模板见 `docs/development.md §10.7`）。

### 2.6.1 ★ 实测：**类型系统自己会拦住"只改一处"**（2026-09-22，试完就回退了）

我先只在 `types.ts` 的 `ExtractDeps` 里加了 `transcribe?`，然后跑 `tsc --noEmit`：

```text
src/lib/extract/depsCatalog.ts(59,14): error TS2741:
  Property 'transcribe' is missing in type '{}' but required in type 'Record<"transcribe", never>'
```

⇒ 这不是"我猜会有 6 处耦合"，而是**编译器点名了第一处**（`depsCatalog.ts` 的键集**由 `ExtractDeps` 推导**，
少一格就当场红）。**我把这次改动回退了**（`git checkout` + `tsc` exit=0），理由：
剩下那 5 处（registry／§15 矩阵／三条一致性判据／抽取器本体）我这一轮预算不够，
**留一个 tsc 红的仓比留一份写着清单的计划更坏**。

⇒ **下一轮的第一枪就是它**：按 §2.5 那份 6 处清单一次做齐；顺序建议
`types.ts` → `depsCatalog.ts`（让 tsc 把下一处点出来）→ `registry.ts` → 抽取器 ＋ 判据 → §15 矩阵。
**用编译器当清单**——它会一处一处点，比人肉记准。






模块位置：`src/lib/extract/audio.ts`（与 `image.ts`/`text.ts`/`pdf.ts` 同族：都是"外部东西 → 文本"）。

| 函数 | 签名（拟） | 判据要点 |
|---|---|---|
| `audioMetaOf(bytes)` | `(Uint8Array) => {ext, bytes, durationSec?}` | 认 `wav/mp3/m4a/ogg/flac`；**不可解码也要给出 ext+bytes**；未知容器 ⇒ 显式 `null` 扩展名而不是猜 |
| `transcribeBodyOf(meta, {model, language?})` | `=> FormData/字段表` | model 必填；**默认 `funasr-nano`**；language 缺省不塞空串 |
| `normalizeTranscript(json)` | `=> {text, hasPunct, segments?}` | 兼容两种返回：`{text}` 与 `{text, segments[]}`；**hasPunct 由文本判定并回报**（不靠模型名推断） |
| `transcriptToDocText(t, {withPunct})` | `=> string` | `withPunct=false` 时**剥标点**（而不是"希望模型不给"）；空白/换行归一 |

## 4. 判据三层（与本层其它功能同形）

1. **纯函数**（`src/lib/extract/audio.test.ts`）：上表四格，各 2–4 条；含"未知容器不许猜"、
   "`withPunct=false` 必须真的剥掉标点"、"两种返回形状都归一到同一结果"；
2. **集成**（注入假端点，不碰真模型）：断言"转写文本**进了文档内容层**、且随后能被索引/总结读到"——
   这条正是"不引第二份派生实现"的守卫；
3. **live 冒烟**（一条，走真模型）：TTS 合成 → 转写 → 断言文本包含预期词
   （模板见 `docs/development.md §10.7`；**边界**：合成干净音，不等于真人口音/远场）。

## 5. 待定（等回话，不阻塞第 3 节）

### 5.0 ★ 原子落地的**第四件**：契约文档本身也被判据守着（2026-09-22 读到）

`depsCatalog.test.ts` 里有一条判据原话是「**契约文档里列了每个能力（防「代码加了、文档没加」）**」
⇒ 所以原子清单不是 3 件而是 **4 件起步**，而且**顺序不能省**：

```
① src/lib/extract/types.ts          加 ExtractDeps.transcribe?
② src/lib/extract/depsCatalog.ts    登记 transcribe（并把 vision.usedBy 里错列的 av.transcript 移走）
③ docs/plans/2026-09-17-…-plan.md §15   ← **必须同批**（有判据比对"能力 ⇄ 文档"）
④ src/lib/extract/registry.ts       登记 avTranscriptExtractor（这一步才补上"能力 ⇄ 已落地抽取器"的配对）
⑤ avTranscript.ts / .test.ts        删掉那两个**局部窄类型**（契约一进就删）
⑥ 验证：tsc ＋ vitest src/lib/extract（depsCatalog / isolated / coverage / conformance 四条一致性判据）
```

**上一轮的两条经验（都吃过）**：
- 只加"能力"不落地抽取器 ⇒ 判据红（`1 failed | 2 passed`，我按纪律回退了）；
- **先留日志再回退** —— 我上次把失败日志删早了，导致那两条断言的原文没读到（下次先 `cat` 再 revert）。

### 5.1 入口与参数（**2026-09-22 macOS 侧已拍**，见 §7）

1. **入口**：AI 面板加「音频转写」／走导入（拖音频文件）／挂到附件 —— 归 mac 定，我不擅自改他的文件；
2. 语言参数是否要（中文默认？中英混说？）；
3. 长音频要不要分段（→ 与 §4-2 的"进内容层后可被总结"耦合：分段粒度决定总结的输入形状）。

## 6. ★ 平台侧实装已落地（2026-09-22，macOS 侧；§5.1 的三问同批给了答案）

上一节 §5.1 那三个"等回话"的问题，这一节就是回答 + 落地读数。

### 6.1 三个答案

| 问题 | 决定 | 为什么 |
|---|---|---|
| **入口放哪** | **导入 / 附件那条路**（与 `image.ocr`／`pdf.text` 同一处触发），**不挂 AI 面板的按钮** | 产物形状是「内容 ＋ `loc="HH:MM:SS"`」，与 OCR／PDF 文字同类；§15.4 的注册表是**按 mime/扩展名**分派的 ⇒ 一个 `.m4a` 附件在笔记里就该能被抽，**不该要求用户先打开 AI 面板**。AI 面板只做**消费**（把已有抽取结果当素材） |
| **语言参数** | 要，但**可选透传**（`language?`，不给就不发这个字段） | 不给时让服务端用它自己的默认（中文场景由模型决定），我们不猜；要固定中文时调用方显式传 `zh` |
| **长音频分段** | **按端点给的段走，UI 侧不做二次切分** | 契约本来就是"每段一条 `kind=transcript`"（`loc` 来自 `start`）⇒ 分段粒度已经在契约里。若**平台侧**因模型窗口必须切，切完必须**按时间戳还原到整段音频的时间轴**（不能每块从 `00:00:00` 重新计），**别把 N 段糊成一段** —— 那会把 `loc` 这个唯一的定位能力丢掉 |

另：`hasPunct` **不进返回值**（AMD 已在契约里裁定），与上面"标点不能成为下游的隐式依赖"是同一条。

### 6.2 落地：`src/lib/ai/localTranscribe.ts`

与 `localVision` **同一条红线**（复用同一个 `isLoopbackBaseUrl` 判据，不另写一份）：

```text
localTranscribe(config, { model?, language?, timeoutMs? })
  → { transcribe?, refusal? }        // 非本机 ⇒ 只有 refusal，下游按"未注入"走 provider_error
transcribe(audio, mime, { model?, language? })
  → POST <base>/v1/audio/transcriptions   multipart: file(+文件名按 mime 给扩展名) / model / language?
  → 解析 {text} 或 {text, segments:[{start,end,text}]}   别的形状**抛**，不猜字段名
```

四条刻意写下来的取舍：

1. **默认模型写死 `funasr-nano`**（owner 拍板），且**不用 `config.model`** —— 那是**文本对话模型**的名字，
   拿去打转写端点必然 404（两个模型空间不是一回事）；
2. **传输走 `coreFetch`** ⇒ 桌面端是 `@tauri-apps/plugin-http`（**原生请求，不经 WebView**）
   ⇒ **桌面没有 CORS 这一关**；`capabilities/default.json` 的 http 作用域含 `http://**` ⇒ `127.0.0.1:8080` 在范围内。
   ★ Windows 2026-09-22 提醒的"CORS 未验"**只作用在 Web 端**（浏览器 fetch），桌面端不适用；
3. **超时默认 5 分钟**（转写比视觉慢得多）；404 的报错**单独给一句指路**（"这台机器上装了哪个 ASR 模型看 `GET /v1/models`"）；
4. **空音频（0 字节）不是模型问题** ⇒ 报错明说"问题在取字节"（与视觉对空图的处置同口径）。

接线链（**每一跳都漏不得**，漏了结果与"没配置"长得一模一样）：

```text
AiSettingsForm.runIndex  →  runLibraryIndex({ vision, transcribe })
  → indexLibrary  → indexPage/indexUnfiled → indexOne → extractAttachment → attachmentDeps  → avTranscriptExtractor
```

### 6.3 判据读数（机读，全绿）

```text
src/lib/ai/localTranscribe.test.ts       15 条   （红线 2 / 请求形状 2 / 响应归一 5 / 失败路径 4 / 纯函数 2）
src/lib/indexPage.test.ts                19 条   （+2：没注入 transcribe ⇒ provider_error；
                                                  ★ 注入了 ⇒ 真的被调用 ＋ 段进内容层（loc=HH:MM:SS）＋ 顺手分块）
src/lib/platform/extractDeps.test.ts     14 条   （+1：transcribe 透传；两条通道各自独立，不许互相变出来）
$ npx tsc --noEmit                       exit=0
$ vitest run src/lib/extract src/lib/ai src/lib/platform
  Test Files 38 passed | 3 skipped (41)   Tests 398 passed | 6 skipped (404)
```

### 6.4 ⚠️ 还没证的两件事（不许读成"验过了"）

1. **真模型那条链路没跑过**：本机 herdsman 现在**没在跑**（`vitest` 里 `librarySummary.live` 报
   `ECONNREFUSED 127.0.0.1:8080`；Windows 验收机同一条：`curl` exit=7）⇒ 现在的绿全是**假端点**那层；
   要真读数得先让桌面应用的「模型商店」把服务起起来，再跑一次 §10.7 的闭环冒烟；
2. **Web 端 CORS 未实测**（桌面不受影响，理由见 6.2-②）。

### 6.5 顺带发现的一条**参数优先级**问题（不是本轮的错，记下来免得以后查）

抽取器 `avTranscript.ts` **写死**了 `transcribe(bytes, mime, { model: DEFAULT_ASR_MODEL })`
（AMD 的判据 `calls == [{mime, model: DEFAULT_ASR_MODEL}]` 也钉着它）⇒
`localTranscribe(config, { model: "sherpa-onnx-paraformer-zh-small" })` 里那个模型**今天不会生效**，
因为"本次调用"优先于"构造时"。

⇒ 结论：**用户可配 ASR 模型这件事现在做不到**，要做得改抽取器那一行（让它别硬编码默认值、
把"用哪个模型"变成真参数）。这属于**抽取层**的口径，我没有擅自改（那边有判据钉着），
已在信箱里提给 AMD。在那之前：换模型＝改 `DEFAULT_ASR_MODEL` 或在调用侧直接把 `transcribe` 换掉。

#### 6.5.1 ★ 裁定（2026-09-22，AMD）：走 **A**，已落地

| 选项 | 裁定 |
|---|---|
| **A（采纳）**：抽取器**不传** `model`，把默认交给注入方 | ✅ **已落地**：`transcribe(bytes, mime, {})` —— 于是优先级成立（**本次调用 > 构造时 > 默认**），"用户可配 ASR 模型"这件事才真的能做到 |
| B（保留现状 ＋ 文档写清） | 否 —— "配置了不生效"是个**安静**的坑（不报错，只是用回默认），比多一个参数坏 |
| C（构造时参数压过本次调用） | 否 —— 契约上"调用方说的算"更自然；将来要按附件覆盖模型会打架 |

**默认值仍然只有一处**：`DEFAULT_ASR_MODEL`（抽取层导出，`= funasr-nano`，owner 拍板），
`localTranscribe` **import 它**（本来就是）⇒ 走默认那条路的行为**与裁定前逐字一致**，配置那条路才通。
判据（`avTranscript.test.ts`）：① 调用参数必须是 `{ model: undefined }`（**钉住"不许再强制默认值"**
—— 这一条正是上面那个"安静盖掉"的回归守卫）；② `DEFAULT_ASR_MODEL` 的字面值锁死。
