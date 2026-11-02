import { api } from "./api";
import { inputDialog, type InputOptions } from "../store/input";
import { toast } from "../store/toast";

/**
 * ⭐ **2026-10-28（owner 选 A）：加密空间「一次性口令接入」向导** —— 可测的那一层（不依赖渲染）。
 *
 * ## 它解决什么
 * 配对之后、还没解锁时，本机可能"钥匙袋里有 N 个加密空间，但一个都没建"（`pendingAdopt > 0`）。
 * 以前界面上只有一行灰字说"解锁一次后会自动接进来"，**没有动作入口** ⇒ 用户不知道该去哪儿。
 * ⇒ 这里给一个入口：输**一次**口令 ⇒ 解锁 ⇒（后端已有的）"解锁后依公开材料自动建空间"接管 ⇒
 * 界面重读 `space_sync_state`，`pendingAdopt` 归零。
 *
 * ## 三条纪律
 * ① ⛔ **口令不落任何日志/状态**（只作为参数传下去）✗；
 * ② 成功/失败都**如实说**（失败把后端原文带上，⛔ 不吞 ✗）；
 * ③ 刷新读数失败**不影响**"已接入"这个结论（⛔ 不因为一次读不到就说没接成 ✗）。
 */
export interface EncryptedAdoptDeps {
  /** 打开口令输入框（默认 `inputDialog`；判据里替换掉 ✓）。 */
  prompt?: (options: InputOptions) => void;
  /** 解锁（默认 `api.unlockEncryption` ✓）。 */
  unlock?: (passphrase: string) => Promise<void>;
  /** 解锁后重读界面读数（`space_sync_state`）——失败不改变结论 ✓。 */
  refresh?: () => Promise<void>;
  /** 提示（默认 `toast` ✓）。 */
  notify?: (message: string, kind?: "info" | "success" | "error") => void;
}

/** 打开向导：问一次口令；用户取消 ⇒ 什么都不做 ✓。 */
export function startEncryptedAdopt(pending: number, deps: EncryptedAdoptDeps = {}): void {
  if (!Number.isFinite(pending) || pending <= 0) return;
  const prompt = deps.prompt ?? inputDialog;
  prompt({
    title: `接入 ${pending} 个加密空间`,
    placeholder: "输入口令（与对端那台一致）",
    type: "password",
    okLabel: "解锁并接入",
    cancelLabel: "取消",
    onSubmit: (value: string) => {
      // ⛔ 不 await：输入框先关掉，接入在后台继续；结果用 toast 说 ✓
      void adoptWithPassphrase(value, pending, deps);
    },
  });
}

/** 真正"拿口令去解锁并接入"的那一步（判据直接调它 ✓）。 */
export async function adoptWithPassphrase(
  passphrase: string,
  pending: number,
  deps: EncryptedAdoptDeps = {},
): Promise<"adopted" | "failed"> {
  const notify = deps.notify ?? ((m, k) => toast(m, k));
  const unlock = deps.unlock ?? ((p: string) => api.unlockEncryption(p));
  const pass = (passphrase ?? "").trim();
  // ⛔ 空口令不发请求（否则后端回一句"口令不对"，而用户其实一个字都没输 ✗）
  if (!pass) {
    notify("口令是空的，没有开始接入", "error");
    return "failed";
  }
  try {
    await unlock(pass);
    notify(`口令正确：正在接入 ${pending} 个加密空间并开始同步`, "success");
  } catch (e) {
    notify(`接入失败：${e instanceof Error ? e.message : String(e)}`, "error");
    return "failed";
  }
  try {
    await deps.refresh?.();
  } catch {
    // 读不到读数只影响"面板这一秒显示什么"，不影响"已经接入了"这个事实 ✓
  }
  return "adopted";
}
