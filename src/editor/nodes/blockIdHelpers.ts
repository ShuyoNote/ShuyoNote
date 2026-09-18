// 「自有节点」块身份的两个小助手（第 4 步铺开 18 个自有节点时用）。
//
// 自有节点的类**就是类型** ⇒ 不需要新 type/映射，只要类里有声明字段，再把 JSON 读写对齐。
// 这两个助手只为少写重复代码，**不隐藏任何语义**：
//   · `withBlockId`：**空 ID 不写字段** —— 嵌套实例不给身份，落盘形态与今天一致（这条是硬承诺）；
//   · `blockIdOf`：从任意序列化 JSON 里安全读 `blockId`（非字符串/缺失 ⇒ 空串）。

/** 只带走身份：非空才把 `blockId` 写进 JSON。 */
export function withBlockId<T extends object>(json: T, blockId: string): T & { blockId?: string } {
  return blockId ? { ...json, blockId } : json;
}

/** 从序列化 JSON 里读 `blockId`（不是字符串就当作没有）。 */
export function blockIdOf(serialized: { blockId?: unknown }): string {
  return typeof serialized.blockId === "string" ? serialized.blockId : "";
}
