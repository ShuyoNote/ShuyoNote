// 「远端事实」的**三态判定** —— 深检（`check-release-state.mjs --deep`）用它决定
// "这条读数是**通过** / **红** / **未实查**"。
//
// ## 为什么需要第三种状态（这是本模块存在的唯一理由）
//
// 发布后自检里最容易犯的错是**把"我没取到"报成"东西不对"**：
// 网络到不了 GitHub、token 过期、服务端 502 —— 这三种都**不是**"我们发错了包"，
// 但一个只认 `code === 200` 的断言会把它们全报成红 ⇒ 人被叫起来去查一个不存在的问题
// （或者更坏：学会了"这条红可以忽略"，于是真的不符也一起被忽略）。
//
// 反过来也有一条纪律：**404 与 200 都是"事实"** —— 资源不在就是不在，值不符就是不符，
// 这两种必须照旧报红。所以"取不到"与"不符"的分界不能拍脑袋，得写死在一处。
//
// ## 判据（`remote-fact.test.mjs` 逐条钉住）
//
// | 情形 | 判定 | 为什么 |
// |---|---|---|
// | `ok === true`（HTTP 2xx） | **通过** | 值对不对由调用方比（本模块只看"取到没有"） |
// | HTTP **404** | **红** | "资源不存在"是事实，不是网络问题（约束③） |
// | HTTP 401/403 | **未实查** | 凭据问题：我们没资格看，**不能**由此断定发布状态 |
// | HTTP 5xx / 429 / 其它 4xx | **未实查** | 服务端或我们的请求有问题 ⇒ 不足以判定"发错了" |
// | 网络类失败（DNS/连接/超时，两条路都走完） | **未实查** | 到不了 ≠ 东西不对 |

/**
 * @param {{ok?: boolean, status?: number|null, failure?: {kind?: string, code?: string}|null}} r
 *        `gh-fetch.mjs::fetchWithFallback` 的返回值（子集即可，便于注入假实现）
 * @returns {{kind: "ok"|"red"|"unverified", why: string, code: string}}
 */
export function fetchVerdict(r) {
  if (r?.ok) return { kind: "ok", why: "取到了（HTTP 2xx）；值对不对由调用方比", code: "ok" };

  const status = typeof r?.status === "number" ? r.status : null;
  if (status === 404) {
    return { kind: "red", why: "HTTP 404：资源不存在 —— 这是**事实**，不是网络问题", code: "404" };
  }
  if (status === 401 || status === 403) {
    return { kind: "unverified", why: `HTTP ${status}：凭据/权限问题，我们没资格看 ⇒ 不足以判定发布状态`, code: String(status) };
  }
  if (status !== null) {
    return {
      kind: "unverified",
      why: `HTTP ${status}：服务端或请求本身的问题（不是"我们发错了"）⇒ 未实查`,
      code: String(status),
    };
  }
  const code = r?.failure?.code || r?.failure?.kind || "network";
  return { kind: "unverified", why: `网络类失败（${code}）：到不了 ≠ 东西不对`, code: String(code) };
}

/** 三态里只有 `red` 该让自检**红**；`unverified` 打印一行"未实查"就过。 */
export function isRed(verdict) {
  return verdict?.kind === "red";
}
