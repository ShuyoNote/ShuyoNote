// 语音输入：**说话 → 文字 → 插到光标处**（owner 2026-10-06：「要 Lexical 官网示例那个话筒按钮」✓）。
//
// 走的是浏览器/WebView 的 **Web Speech API**（`SpeechRecognition` / `webkitSpeechRecognition`）✓
// —— Lexical 的 playground 那个话筒按钮用的就是它 ✓（它不是 Lexical 的功能，是浏览器的 ✓）。
//
// ## 为什么要单独一个文件、还要能注入 `Ctor`
//   ① 判据要能在**没有麦克风、也没有这个 API** 的环境里真跑 ⇒ 注入一个**假识别器** ✓
//      （happy-dom / jsdom 里两样都没有 ✓；"读源码猜它调没调"不算读数 ✗）；
//   ② **"支不支持"必须如实**：这套 API 在有些 WebView 里**整条不存在** ✗ ——
//      那时要给一句人话（"这个外壳不带语音识别"），⛔ 不是静默没反应 ✗。
//
// ## 边界（照实写，免得被读成"全平台都验过"）
//   · 识别在**哪一侧**跑由浏览器决定：Chromium 桌面版历史上是把音频送到**远端**服务 ✓
//     ⇒ "语音不离开本机"这句话**这条通道给不了** ✗（要本机转写请走 `src/lib/ai/localTranscribe.ts`
//     那条**只许本机端点**的通道 ✓ —— 那是另一件事，别混 ✓）。
//   · 连续识别（`continuous = true`）会由浏览器自己结束（静音一段时间 ✓）⇒ 本模块**如实上报**
//     `onEnd`，由调用方决定要不要说一句"已停" ✓（⛔ 不偷偷重启、也不假装还在听 ✗）。

/** 事件回调（都由调用方决定怎么呈现 ✓）。 */
export interface SpeechInputEvents {
  /** 识别到一段：`isFinal` 为真才算"定稿" ✓（会变的那半截不要往笔记里插 ✗）。 */
  onText: (text: string, isFinal: boolean) => void;
  /** 出错：`code` 是规范里的码 ✓，`message` 是**给人看的一句话** ✓。 */
  onError: (code: string, message: string) => void;
  /** 识别结束（不管是自己停的还是浏览器自己结束的 ✓）。 */
  onEnd: () => void;
}

/** 我们真正用到的那个子集（只声明用到的 ⇒ 假识别器好造 ✓）。 */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onend: (() => void) | null;
}

/** 这台机器/这个外壳有没有语音识别 ✓（没有 ⇒ 按钮要**如实**说一句 ✗）。 */
export function speechInputSupported(win: any = globalThis as any): boolean {
  return typeof win?.SpeechRecognition === "function" || typeof win?.webkitSpeechRecognition === "function";
}

/**
 * **中间结果气泡**的位置（纯函数 ⇒ 可判据 ✓）。
 *
 * owner 2026-10-06（附 Lexical playground 截图）：「语音录入时，实时显示文字」✓ ——
 * playground 那颗话筒说话时会在**光标附近**浮一句半截的话 ✓，定稿才落进正文 ✓。
 * ⇒ 这里只决定"浮在哪"：跟着光标 ✓；没有光标（编辑器还没被点过 ✓）就用按钮的位置 ✓；
 *   两种都没有就摆屏幕下方中间 ✓；**一律夹在视口里** ✓（⛔ 不许浮到屏幕外 ✗）。
 *
 * ⚠️ 宽度是**估**的（气泡宽度由 CSS 定 ✗）—— 只用来做夹取，宁可夹紧一点 ✓。
 */
export function interimBubbleStyle(
  anchor: { left: number; top: number } | null,
  fallback: { left: number; right: number; top: number } | null,
  view: { width: number; height: number },
  approx = { width: 340, height: 48 },
): { left: number; top: number } {
  const a = anchor ?? (fallback ? { left: fallback.left + (fallback.right - fallback.left) / 2, top: fallback.top } : null);
  const x = a ? a.left : view.width / 2 - approx.width / 2;
  // 光标**上方**（playground 也是浮在上面 ✓）；贴到顶部就翻到下方 ✓
  const above = a ? a.top - approx.height - 10 : view.height - 140;
  const y = above < 8 ? (a ? a.top + 28 : above) : above;
  const left = Math.max(8, Math.min(x, Math.max(8, view.width - approx.width - 8)));
  const top = Math.max(8, Math.min(y, Math.max(8, view.height - approx.height - 8)));
  return { left: Math.round(left), top: Math.round(top) };
}

/** 光标（或选区）在屏幕上的位置 ✓；拿不到 ⇒ `null`（调用方退到按钮位置 ✓）。 */
export function caretAnchor(doc: any = globalThis.document): { left: number; top: number } | null {
  try {
    const sel = doc?.getSelection?.();
    if (!sel || sel.rangeCount === 0) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect) return null;
    // 折叠选区（只有光标 ✓）宽度可能是 0 ⇒ 仍然可用 ✓；两个都 0 才算拿不到 ✓
    if (!rect.width && !rect.height) return null;
    return { left: rect.left, top: rect.top };
  } catch {
    return null;
  }
}

/** 拿识别器构造函数（优先标准名 ✓，退到 `webkit` 前缀 ✓）。 */
export function speechRecognitionCtor(win: any = globalThis as any): (new () => SpeechRecognitionLike) | null {
  return win?.SpeechRecognition ?? win?.webkitSpeechRecognition ?? null;
}

/**
 * 规范里的错误码 → **给人看的一句话**（每条都写"下一步怎么办" ✓，别只说"出错了" ✗）。
 * 逐条来由：`not-allowed` 是权限被拒 ✓；`service-not-allowed` 常见于**外壳不带识别服务** ✓
 * （它和"用户拒绝"不是一回事，所以话不一样 ✓）；`network` 是识别服务连不上 ✓；
 * `no-speech` / `audio-capture` 分别是"没听到"与"没拿到麦克风" ✓。
 */
export function speechErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
      return "麦克风权限被拒了 —— 请在系统/浏览器设置里允许本应用使用麦克风，再点一次";
    case "service-not-allowed":
      return "这个外壳不带语音识别服务（WebView 常见）—— 换桌面版浏览器试，或改用本机转写通道";
    case "network":
      return "语音识别服务连不上（这条通道通常要用到网络）—— 检查网络后重试";
    case "no-speech":
      return "没听到声音 —— 靠近麦克风、说大声一点再试";
    case "audio-capture":
      return "没拿到麦克风 —— 检查设备是否被其它程序占用";
    case "aborted":
      return "识别被中断了";
    default:
      return `语音识别出错（${code}）`;
  }
}

/**
 * 造一个语音输入（不自动开始 ✓ —— 由调用方在**用户点击**时 `start()` ✓，
 * ⓘ 浏览器要求 `start()` 必须发生在用户手势里 ✓）。
 */
export function createSpeechInput(opts: {
  events: SpeechInputEvents;
  /** 识别语言 ✓（默认跟界面一致的中文 ✓）。 */
  lang?: string;
  /** 注入点（判据用假识别器 ✓）。 */
  Ctor?: (new () => SpeechRecognitionLike) | null;
}) {
  const Ctor = opts.Ctor === undefined ? speechRecognitionCtor() : opts.Ctor;
  if (!Ctor) {
    return {
      supported: false as const,
      start: () => opts.events.onError("service-not-allowed", speechErrorMessage("service-not-allowed")),
      stop: () => {},
      listening: () => false,
    };
  }
  const rec = new Ctor();
  rec.lang = opts.lang ?? "zh-CN";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let listening = false;

  rec.onresult = (ev: any) => {
    const results = ev?.results ?? [];
    for (let i = ev?.resultIndex ?? 0; i < results.length; i++) {
      const r = results[i];
      const text = r?.[0]?.transcript ?? "";
      if (!text) continue;
      opts.events.onText(text, r?.isFinal === true);
    }
  };
  rec.onerror = (ev: any) => {
    const code = String(ev?.error ?? "unknown");
    // ⚠️ `aborted` **一律不当错误** ✓ —— 这套 API 里"中止"只有一条来路（我们自己 `stop()`／`abort()` ✓），
    //    用户对此**无可作为** ⇒ 弹一句红字只会让人以为坏了 ✗。
    //    （写这行之前我先用了"是否我们自己停的"那个标志 ✗ —— 判定挂在 `onend` 之后就被清掉了，
    //     于是**晚到的** `aborted` 还是被当成错误 ⇒ 判据当场拍到 ✓；`aborted` 本来就无需分支 ✓。）
    if (code === "aborted") return;
    opts.events.onError(code, speechErrorMessage(code));
  };
  rec.onend = () => {
    listening = false;
    opts.events.onEnd();
  };

  return {
    supported: true as const,
    start: () => {
      if (listening) return;
      listening = true;
      rec.start();
    },
    stop: () => {
      if (!listening) return;
      listening = false;
      try {
        rec.stop();
      } catch {
        // 已经停了 ⇒ 无所谓 ✓
      }
    },
    listening: () => listening,
  };
}
