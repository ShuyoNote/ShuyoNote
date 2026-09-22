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

## 3. 纯函数层（**先做这一层；不依赖任何人的拍板**）

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

1. **入口**：AI 面板加「音频转写」／走导入（拖音频文件）／挂到附件 —— 归 mac 定，我不擅自改他的文件；
2. 语言参数是否要（中文默认？中英混说？）；
3. 长音频要不要分段（→ 与 §4-2 的"进内容层后可被总结"耦合：分段粒度决定总结的输入形状）。
