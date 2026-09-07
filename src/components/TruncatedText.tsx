// 省略文本的 hover 完整说明：直接用原生 title，hover 一定出现。
// 用于看板 / 数据库看板等被省略的卡片标题。
export function TruncatedText({ text, className }: { text: string; className?: string }) {
  return <span className={className} title={text}>{text}</span>;
}
