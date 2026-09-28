// 旧二进制 Office（`.doc` / `.xls` / `.ppt`）的平台转换器 —— `deps.convertLegacy` 的**唯一构造点**。
//
// ## 为什么它在平台层，而不是抽取层
// 抽取层（`src/lib/extract/**`）**不许依赖平台**（`isolated.test.ts` 有源码级断言），
// 而"把旧格式转成 OOXML"要**起一个外部进程**（LibreOffice headless）⇒ 只能落在平台侧。
// 它与"模型驱动"（`vision` / `transcribe`）**不是一回事**：转换不需要端点、密钥或模型，
// 所以这里的做法与那两者**刻意不同** —— 那两者由调用方给（平台还没有模型驱动层），
// 而转换由**平台命令面**提供（桌面有、Web 没有）。
//
// ## 三条与契约（`src/lib/extract/types.ts` 的 `convertLegacy`）逐条对齐的口径
//  1. **`to` 由抽取器决定**，这里原样转发；**只回字节、不回 mime**（少一处能漂的地方）；
//  2. **失败一律 reject**（平台没有这条命令 / 命令报错 / 超时）：抽取器把它映射成 `provider_error`——
//     那是**如实答复**，不是"文件里没有内容"（§15.3-7 / §15.10）；
//  3. **不在这里判断"这台机器有没有 LibreOffice"**：那是命令自己的事（它会返回一条点名怎么装的原话），
//     在这里猜只会多一处会漂的判据。

import type { ExtractDeps } from "../extract/types";

/** 命令面最小接口（与 `Platform["executor"]` 同形；只要 invoke ⇒ 判据能注入假执行器）。 */
export interface ByteCommandInvoker {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

/**
 * 构造 `convertLegacy`。
 *
 * ⚠️ **字节形状**：命令面走 `number[]`（与既有 `write_attachment_bytes` 同一约定）。
 * 旧 Office 文档通常是几百 KB 量级，这条路的开销可以接受；**不要**把大附件往这条路上引
 * （真要大字节量，那是"命令面该不该走 ArrayBuffer"的另一件事，别在这里顺手改）。
 */
export function legacyConverterFor(invoker: ByteCommandInvoker): NonNullable<ExtractDeps["convertLegacy"]> {
  return async (bytes, _mime, opts) => {
    const out = await invoker.invoke<number[] | Uint8Array>("convert_legacy_office", {
      data: Array.from(bytes),
      to: opts.to,
    });
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  };
}
