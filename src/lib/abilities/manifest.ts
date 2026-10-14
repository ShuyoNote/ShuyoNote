// ⭐ **第 0 片（2026-10-14）**：「能力清单」从**写死在 TS** 改成 ⭐ **可下发** ✗
//   （＋ ⭐ **取不到就回退到内置那份** ✓ —— ⛔ 不许整屏空白 ✗）。
//
// ## 形状（⭐ 与屏里那份**逐字同形** ✓，⛔ 不新造第二套字段 ✗）
// · `id` ／ `name` ／ `summary` ⇒ **必需**（缺 ⇒ 那一条**整条丢掉** ✓，⛔ 不猜 ✗）；
// · `path`（镜像仓内相对路径 ✓）／ `sha256` ⇒ **任缺 ⇒ 那一条不许是 `downloadable`** ✗；
// · `state` ⇒ 三态 ✓（`builtin` ／ `downloadable` ／ `not-available`）；
// · `bytes` ／ `note` ⇒ 可选 ✓。
//
// ## ⭐ 两条规矩（本片的全部要害 ✓）
// 1. ⭐ **只认真实值** ✗：⭐ 远端**自称** `downloadable` 但 `path`／`sha256` 缺 ⇒
//    ⭐ **降级成 `not-available`** ✓（`normalizeAbility` ✓）—— ⛔ 不许信远端说了算 ✗
//    （渲染层那颗按钮另有一道同样的守卫 ✓：`AbilitiesPane.tsx` 的 `if (!a.path || !a.sha256) return;` ✓）；
// 2. ⭐ **内置那份是底** ✗：远端的**逐 `id` 覆盖／追加**（`mergeAbilities` ✓）——
//    ⚠️⭐ 这条是**行为等价**的关键 ✓：`office-import`（`builtin` ✓）与 `ecdict-en-zh`
//    （`downloadable`，path／sha256 齐 ✓）**留在代码里** ✓ ⇒ ⭐ **ECDICT 的既有行为不变** ✓
//    （⛔ 上游清单里没有它 ⇒ 它不会被抹掉 ✗）。
//
// ## ⚠️ 想让某一件**上架**，正确动作是什么（⛔ 本片不替谁做这个决定 ✗）
// ⭐ 在镜像仓那份 `manifest.json` 里给**真实**的 `path` ＋ `sha256` ＋ `state: "downloadable"` ✓
//   —— ⭐ 那属于**那一件自己的落地**（＋ owner 拍 ✓），⛔ 不是本片"顺手放出来" ✗。
//
// ## ⚠️ 本模块**不做**什么（⭐ 如实 ✗）
// ⛔ 不下载任何东西 ✗、⛔ 不校验包 ✗、⛔ 不落盘 ✗ —— ⭐ 通用下载器（contents→blobs 两步 ＋
// **两道 sha256** ＋ 先 `.part` 再 rename ✓）是**下一片** ✓（⭐ 先例＝`dictionary.rs` 那条链 ✓）。
export type AbilityState = "builtin" | "downloadable" | "not-available";

/** 清单条目 —— ⭐ 只认**真实值** ✓（`path` ／ `sha256` 任缺 ⇒ 不许出现下载按钮 ✗）。 */
export interface Ability {
  id: string;
  name: string;
  summary: string;
  bytes?: number;
  /** 镜像仓内的相对路径（相对 `https://gitcode.com/shuyo-cn/shuyo-mirror` ✓） */
  path?: string;
  sha256?: string;
  /** 状态：真实三态 ✓ */
  state: AbilityState;
  note?: string;
}

/** ⭐ 与 ECDICT 那条链**同一个源** ✓（`AbilitiesPane.tsx` 的 `API` ✓ —— ⛔ 别写第二份 base ✗）。 */
export const MIRROR_CONTENTS_API =
  "https://api.gitcode.com/api/v5/repos/shuyo-cn/shuyo-mirror/contents/";

/** 清单在镜像仓里的位置 ✓（⭐ 与 ECDICT 的 `mirror/…` 同仓 ✓）。 */
export const MANIFEST_FILE = "manifest.json";

const STATES: readonly AbilityState[] = ["builtin", "downloadable", "not-available"];

const nonEmpty = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
};

/** 单条：⭐ 形状不认识 ⇒ `null`（**整条丢掉** ✓，⛔ 不补默认值 ✗）。 */
export function normalizeAbility(raw: unknown): Ability | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = nonEmpty(o.id);
  const name = nonEmpty(o.name);
  const summary = nonEmpty(o.summary);
  if (!id || !name || !summary) return null; // ⛔ 三格缺一 ⇒ 丢掉 ✓（别猜 ✓）
  const path = nonEmpty(o.path);
  const sha256 = nonEmpty(o.sha256);
  const rawState = nonEmpty(o.state);
  let state: AbilityState = STATES.includes(rawState as AbilityState)
    ? (rawState as AbilityState)
    : "not-available"; // ⭐ 不认识的状态 ⇒ 按"还没上架"处理 ✓（⛔ 不默认成能下 ✗）
  let note = nonEmpty(o.note);
  // ⭐⭐ **本片的要害** ✗：自称能下、字段却缺 ⇒ **降级** ✓（⛔ 不许信远端说了算 ✗）
  if (state === "downloadable" && (!path || !sha256)) {
    state = "not-available";
    note = note ?? "清单里缺 path／sha256 ⇒ 按「还没上架」处理";
  }
  const bytes = typeof o.bytes === "number" && Number.isFinite(o.bytes) && o.bytes > 0 ? o.bytes : undefined;
  return { id, name, summary, bytes, path, sha256, state, note };
}

/** 整份：⭐ 形状不认识 ⇒ `null`（⇒ 调用方回退到内置那份 ✓，⛔ 不许拿半份拼 ✗）。 */
export function parseAbilitiesManifest(raw: unknown): Ability[] | null {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { abilities?: unknown }).abilities)
      ? ((raw as { abilities: unknown[] }).abilities as unknown[])
      : null;
  if (!list) return null;
  const out: Ability[] = [];
  for (const item of list) {
    const a = normalizeAbility(item);
    if (a) out.push(a);
  }
  // ⭐ 一条都不认识 ⇒ 当作"这份清单不成立" ✓（⛔ 不许拿空列表去顶掉内置那份 ✗）
  return out.length > 0 ? out : null;
}

/** ⭐ 内置那份是**底** ✓：远端逐 `id` **覆盖／追加** ✓ —— ⛔ 不许整份替换 ✗（会抹掉代码里那两条 ✓）。 */
export function mergeAbilities(builtin: Ability[], remote: Ability[]): Ability[] {
  const byId = new Map(builtin.map((a) => [a.id, a]));
  const order = builtin.map((a) => a.id);
  for (const r of remote) {
    if (!byId.has(r.id)) order.push(r.id);
    byId.set(r.id, r);
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

/** 回退时的**人话原因** ✓（⭐ 判据要它非空 ✓ —— ⛔ 静默回退 ✗）。 */
export interface ManifestLoadResult {
  abilities: Ability[];
  source: "remote" | "fallback";
  reason?: string;
}

/**
 * ⭐ 取清单：`contents` 那一步取 `manifest.json`（⭐ 与 ECDICT 同一个 API 形状 ✓：
 * base64 在 `content` 里 ✓）⇒ 解析 ⇒ ⭐ **并到内置那份上** ✓；
 * ⚠️ **任何一步不成**（网络错 ／ HTTP 非 200 ／ 形状不认识 ／ 一条都认不出 ✓）⇒ ⭐ **回退** ✓ ＋ 给原因 ✓。
 *
 * ⚠️ `fetchImpl` 由调用方给（判据注入夹具 ⇒ ⭐ **一次网都不出** ✓）。
 */
export async function loadAbilitiesManifest(opts: {
  fallback: Ability[];
  fetchImpl?: typeof fetch;
  url?: string;
}): Promise<ManifestLoadResult> {
  const { fallback, fetchImpl, url = MIRROR_CONTENTS_API } = opts;
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!doFetch) return { abilities: fallback, source: "fallback", reason: "这个运行环境里没有 fetch" };
  try {
    const res = await doFetch(`${url}${MANIFEST_FILE}?ref=main`);
    if (!res.ok) {
      return { abilities: fallback, source: "fallback", reason: `取清单失败：HTTP ${res.status}` };
    }
    const j = (await res.json()) as { encoding?: string; content?: string; abilities?: unknown };
    // ⭐ 两种形态都认 ✓：`contents` 那条（base64 ✓）／已经解析好的 JSON ✓
    let raw: unknown = j;
    if (typeof j?.content === "string" && j.content.trim().length > 0) {
      const bin = atob(j.content.replace(/\s/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      raw = JSON.parse(new TextDecoder().decode(bytes));
    }
    const parsed = parseAbilitiesManifest(raw);
    if (!parsed) {
      return { abilities: fallback, source: "fallback", reason: "清单形状不认识 ⇒ 用内置那份" };
    }
    return { abilities: mergeAbilities(fallback, parsed), source: "remote" };
  } catch (e) {
    return { abilities: fallback, source: "fallback", reason: `取清单失败：${String(e)}` };
  }
}
