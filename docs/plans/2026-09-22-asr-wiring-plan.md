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

### 5.1 入口与参数（等回话，不阻塞上面）

1. **入口**：AI 面板加「音频转写」／走导入（拖音频文件）／挂到附件 —— 归 mac 定，我不擅自改他的文件；
2. 语言参数是否要（中文默认？中英混说？）；
3. 长音频要不要分段（→ 与 §4-2 的"进内容层后可被总结"耦合：分段粒度决定总结的输入形状）。
