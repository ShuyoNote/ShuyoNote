import type { EmailAccount } from "./api";

/**
 * 邮箱账号唯一键（与后端 `account_key` 一致：`host|username`，均小写）。
 *
 * 用途：聚合流里靠邮件的 `meta.account` 字段据此反查所属账号；设置里的多账号管理、
 * store 里的账号列表增删改也都用它做身份判断。
 *
 * **只此一处定义。** 它原本在 `EmailPanel` 与 `SettingsDialog` 各写了一份完全相同的实现，
 * 而 store 又需要第三份——三份同逻辑的键函数，任何一处改了算法都只会在别处静默出错，
 * 所以收敛到这里（2026-09-15）。
 */
export function accountKey(a: EmailAccount): string {
  return `${a.host.toLowerCase()}|${a.username.toLowerCase()}`;
}
