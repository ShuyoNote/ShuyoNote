// 通用字符串哈希 —— **一处实现，两处使用**（页面嵌入缓存 + 分块嵌入缓存）。
//
// 为什么把它从 `semanticEmbed.ts` 里抽出来：
// 分块（P2）也要用同一个哈希来判"这段文本变了没有、要不要重算嵌入"。
// 直接从 `semanticEmbed.ts` import 虽然也能跑（那边的 `coreHttp` 是懒加载 Tauri 插件、无静态平台依赖），
// 但那会让**抽取层**的模块图里多出一个"含网络客户端的模块" —— 而抽取层的隔离性
// （`src/lib/extract/isolated.test.ts` 用源码级断言守着）正是它能在 CI/Node 上跑纯函数测试的前提。
// 抽成中性模块后，抽取层只依赖这一个 8 行的纯函数。

/**
 * 确定性 FNV-1a（32 位）哈希，输出 base36。
 *
 * **为什么 32 位够用**：它只用来判"同一份内容变了没有"（缓存失效），
 * 而不是做内容寻址去重。碰撞只在"同一个 key 的内容前后两次撞到同一个值"时才产生影响，
 * 概率约 2⁻³² 每次变更 —— 可忽略。**不要**用它做安全用途或全局去重。
 */
export function fnv1a32(text: string): string {
  const s = String(text ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
