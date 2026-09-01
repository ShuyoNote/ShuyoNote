// 同步目标的短标签与配色：把服务器地址压成 host，并按地址稳定地取一个颜色，
// 让「这个空间同步到哪台服务器」在侧栏、标题栏、同步面板里保持同一种视觉标识。
//
// 抽到 lib 是因为它已经被三处用到（PageTree 的空间行、TitleBar 的状态芯片、
// SyncPanel 的空间标签）——同一个地址在不同位置必须是同一个颜色，否则这套
// 颜色编码就失去意义了。

/** 服务器地址 → 短标签（host，去掉 www.）。 */
export function syncTagLabel(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    return u.host.replace(/^www\./, "");
  } catch {
    return serverUrl.replace(/^https?:\/\//, "").split("/")[0] || "同步";
  }
}

/** 服务器地址 → 稳定的 HSL 颜色（同地址永远同色）。 */
export function syncTagColor(serverUrl: string): string {
  let h = 0;
  for (let i = 0; i < serverUrl.length; i++) h = (h * 31 + serverUrl.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 65% 45%)`;
}
