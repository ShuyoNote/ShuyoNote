// 把日志/错误里可能出现的**凭据**抹掉，再交给终端、CI 日志或文档。
//
// 为什么要有它（2026-09-16 发 1.91.3 时真踩到）：`check-release-state.mjs` 用
// `execFileSync("curl.exe", [... "-H", "Authorization: Bearer ghp_…"])`，curl 失败时
// **Node 抛出的 message 里带着整条 argv**，于是那句 `ok(false, …e.message…)` 把
// GitHub token 原样打进了终端与（CI 上就是）公开可见的日志。
// 同类写法在整个仓库里不止一处，所以收成一个函数，谁要打印外部命令的错误就用它。
//
// 覆盖的形态（都是本仓库真在用/真会出现的）：
//   · `Authorization: Bearer <token>` / 裸 `Bearer <token>`
//   · GitHub token：`ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` / 细粒度 `github_pat_`
//   · gitcode / 通用查询串里的 `token=`、`access_token=`、`private_token=`
//   · URL 里的 `user:pass@host`
// 宁可多抹一点：日志里少几个字符无所谓，凭据进了日志就得轮换。
const PATTERNS = [
  [/\b(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1***"],
  [/\b(gh[pousr]_[A-Za-z0-9]{8,})/g, "gh***"],
  [/\b(github_pat_[A-Za-z0-9_]{8,})/g, "github_pat_***"],
  [/\b((?:access_)?token|private_token|api_key|password|passwd|secret)=([^&\s"']+)/gi, "$1=***"],
  [/(\/\/[^/\s:@]+):([^@\s/]+)@/g, "$1:***@"],
];

export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}
