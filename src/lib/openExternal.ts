// 「打开外部网站」的**唯一出口**（真总闸）。
//
// 为什么要有这一个文件：这个开关（`shuyonote-allow-external`）原先只被「关于」对话框查过一次，
// 而全应用有 6 处会开外部网站（关于 / 社区保存 / 发布到社区 / 插件索引 / 网页书签 / 链接悬浮条）——
// 于是"允许跳转到外部项目网站"这个总闸语气的开关，实际只盖住 1/6，其余照样能把人送出去。
// 现在所有"开外部网站"都走这里：**判定、白名单、拦下时的告知**都在这一处。
//
// 两条边界：
//   · `opener.openPath`（打开**本地文件**）**不走这里**，也不受开关影响 —— 那是离线能力，
//     关掉外链不该让附件的"用系统程序打开"失效（判据里有负向断言钉着）。
//   · 调用点不许自己 `platform.opener.openUrl`：接线判据会扫源码，发现绕过就红。
import { platform } from "./platform";
import { toast } from "../store/toast";
import { decideExternalOpen, externalOpenNotice } from "./links";

/**
 * 打开一个外部网站。**返回是否真的打开了**（调用点一般不需要看，但测试要看）。
 *
 * 三种结果都不静默：关着 ⇒ 说清"是设置拦的、怎么开"；不是 http(s) ⇒ 说清"这链接不能用"；
 * 平台层失败 ⇒ 说清失败原因。静默无反应是以前那版的毛病（点了没反应，人会以为卡死）。
 */
export async function openExternalUrl(raw: string): Promise<boolean> {
  const decision = decideExternalOpen(raw);
  if (decision.kind !== "open") {
    toast(externalOpenNotice(decision), "error");
    return false;
  }
  try {
    await platform.opener.openUrl(decision.url);
    return true;
  } catch (e) {
    toast(`打不开这个链接：${e instanceof Error ? e.message : String(e)}`, "error");
    return false;
  }
}
