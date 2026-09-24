// 隐私边界 A=3 ＋ ②b 的**最小界面**：这个空间**敢不敢绑同步**（分类 ＋ 加密 ＋ 闸门裁决）。
//
// 为什么放在同步面板里：闸门拦的正是「绑同步」这个动作（Rust `sync::sync_bind_gate`），
// 用户撞上拦住的那一刻就在这一屏 ⇒ 读数与动作必须**同屏**，否则他得自己去别处找「为什么绑不上」。
//
// 三条命令（`space_security_overview` / `set_space_kind` / 按空间加解密）都是**桌面专属**
// （Web 没有钥匙柜）。⇒ 这里是**唯一的**平台判定点：Web 上只渲染解释句、**一次 api 都不调**
// （调了就是「command not found」抛错，而那一屏本来就不该有这条动作）。
import { useCallback, useEffect, useState } from "react";
import { api, type SpaceKind, type SpaceSecurityView } from "../lib/api";
import type { SpaceKeyringOutcome } from "../lib/platform/commands";
import { isDesktopPlatform } from "../lib/platform";
import { inlineMd } from "../lib/inlineMd";

const KIND_LABEL: Record<SpaceKind, string> = {
  personal: "个人空间",
  team: "团队空间",
  "": "未分类",
};

/**
 * 同步面板里的「空间隐私」一节。
 *
 * `nameOf` 只影响显示（空间 id 反查名字）；不给就显示 id。
 */
export function SpacePrivacySection({ nameOf }: { nameOf?: (id: string) => string } = {}) {
  const desktop = isDesktopPlatform();
  const [views, setViews] = useState<SpaceSecurityView[] | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [pass, setPass] = useState("");
  // 「关闭加密」是**会把库换回明文**的动作 ⇒ 两步确认（不用 `window.confirm`：
  // 那个在 Tauri 里不保证有实现，静默返回 false 就成了"点了没反应"的静默失败）。
  const [confirming, setConfirming] = useState("");
  // ③ 0b：是否允许「从服务器取回」**覆盖**本机已有的公开材料（默认不许 —— 覆盖是危险动作）。
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  // ③ 0b：每行的推/取结果（**原样**显示后端那句话）。
  const [rowMsg, setRowMsg] = useState<{ id: string; text: string; kind: string } | null>(null);

  const reload = useCallback(async () => {
    if (!desktop) return;
    try {
      setViews(await api.spaceSecurityOverview());
      setErr("");
    } catch (e) {
      setErr(String(e));
    }
  }, [desktop]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (spaceId: string, what: string, fn: () => Promise<unknown>) => {
    setBusy(spaceId);
    setNote("");
    setErr("");
    setConfirming("");
    try {
      await fn();
      setNote(`${what}：已完成`);
      await reload();
    } catch (e) {
      // ⚠️ **原样**显示后端那句话：它本来就是可操作的（说清下一步该做什么）。
      //    自己改写一遍＝把"可操作"抄第二份，两份迟早漂。
      setErr(`${what}失败：${String(e)}`);
    } finally {
      setBusy("");
    }
  };

  /// ③ 0b：推 / 取公开材料。与 `run` 分开，是因为这两条**正常的不顺利也不抛**（用 `outcome` 回），
  /// 所以要把 `outcome` 映射成"提示 / 警告 / 错误"三档，并把那句话**原样**显示出来。
  const runKeyring = async (
    spaceId: string,
    what: string,
    fn: () => Promise<SpaceKeyringOutcome>,
  ) => {
    setBusy(spaceId);
    setNote("");
    setErr("");
    setRowMsg(null);
    try {
      const r = await fn();
      const kind = r.outcome === "ok" ? "ok" : r.outcome === "rejected" ? "err" : "warn";
      setRowMsg({ id: spaceId, text: `${what}：${r.message}`, kind });
      if (r.outcome === "ok") await reload();
    } catch (e) {
      setErr(`${what}失败：${String(e)}`);
    } finally {
      setBusy("");
    }
  };

  if (!desktop) {
    return (
      <section className="space-privacy" data-testid="space-privacy">
        <div className="space-privacy-head">🔐 空间隐私（要在桌面端操作）</div>
        <div className="space-privacy-hint">
          Web 版没有钥匙柜：加密空间在 Web 上不可同步、不可编辑，也不会被降级成明文上传。
        </div>
      </section>
    );
  }

  return (
    <section className="space-privacy" data-testid="space-privacy">
      <div className="space-privacy-head">🔐 空间隐私 —— 每个空间能不能绑同步</div>
      {/* 首屏只留一句结论。**"闸门没管到未分类"这句话只在这里说一次** —— 每行再说一遍就是纯噪声
          （行里的分类徽标已经写着「未分类」，下拉里那句也说清了它为什么被放行）。 */}
      <div className="space-privacy-hint">
        个人空间要先加密才能绑同步；团队空间免检（服务端存明文）；未分类的放行，但闸门没管到它。
      </div>

      {views === null && <div className="sync-empty-state">正在读…</div>}
      {views !== null && views.length === 0 && <div className="sync-empty-state">还没有空间</div>}

      {views?.map((v) => {
        const encrypted = v.encrypted_on_disk || v.in_keyring;
        return (
          <div className="space-privacy-row" key={v.space_id}>
            <div className="space-privacy-line">
              <span className="space-privacy-name" title={v.space_id}>
                {nameOf ? nameOf(v.space_id) : v.space_id}
              </span>
              <span className={`space-privacy-kind is-${v.kind || "unknown"}`}>{KIND_LABEL[v.kind]}</span>
              <span className="space-privacy-enc">{encrypted ? "已加密" : "明文"}</span>
              {/* ★ 判决做成**同一行的短徽标**（不是单独一句）：它才是这一列的主信息，不该被省掉；
                  但"解释"不在这行 —— 未分类为什么放行、个人空间为什么被拦，分别由标题下那一句
                  与被拦时的下一行（**可操作**的那句）负责。 */}
              <span
                className={`space-privacy-verdict ${
                  v.gate.allow ? (v.gate.unclassified ? "is-note" : "is-ok") : "is-block"
                }`}
              >
                {v.gate.allow ? (v.gate.unclassified ? "⚠️ 闸门没管到" : "✅ 可以绑同步") : "⛔ 不能绑同步"}
              </span>
            </div>
            {/* ⚠️ 只有**被拦住**时才占一行 —— 那一行是**可操作**的（为什么拦、怎么解）；
                后端（Rust）文案是 Markdown 行内写法 ⇒ 过 `inlineMd`（否则界面露出 `**`）。 */}
            {!v.gate.allow && (
              <div className="space-privacy-gate is-block">
                <>⛔ {inlineMd(v.gate.reason)}</>
              </div>
            )}
            <div className="space-privacy-actions">
              <select
                className="sync-input"
                aria-label="空间分类"
                value={v.kind}
                disabled={busy === v.space_id}
                onChange={(e) =>
                  void run(v.space_id, "改分类", () => api.setSpaceKind(v.space_id, e.target.value as SpaceKind))
                }
              >
                <option value="">未分类（放行，但没管到）</option>
                <option value="personal">个人空间（要先加密）</option>
                <option value="team">团队空间（免检）</option>
              </select>
              {encrypted ? (
                <button
                  className="sync-btn ghost"
                  disabled={busy === v.space_id}
                  onClick={() => {
                    if (confirming !== v.space_id) {
                      setConfirming(v.space_id);
                      return;
                    }
                    void run(v.space_id, "关闭加密", () => api.disableSpaceEncryption(v.space_id));
                  }}
                >
                  {confirming === v.space_id ? "确认：换回明文" : "关闭加密（换回明文）"}
                </button>
              ) : (
                <button
                  className="sync-btn"
                  disabled={busy === v.space_id}
                  onClick={() =>
                    void run(v.space_id, "开启加密", () =>
                      api.enableSpaceEncryption(v.space_id, pass || undefined),
                    )
                  }
                >
                  开启加密
                </button>
              )}
            </div>
            {/* ★ owner 第三轮拍板（2026-09-24）：原先这里还有 ① 的两个按钮
                （「把旧钥匙迁进钥匙袋」/「换成真随机钥匙」）。那两条命令与它们背后的整套
                应用级加密一起删掉了 ⇒ 不再有"把旧钥匙搬进袋子"这条出路。
                现在"密文库 ＋ 袋里没有它的盒子"（应用级加密的存量库）唯一的出路是**从别处取回
                公开材料**（下面那句折叠里的按钮；报错那句说的就是它）。 */}
            {/* ③ 0b 换设备：一次设备变更才用一次的动作 ⇒ 收进折叠、**且只在"这个空间真的加密了"时出现**
                （明文空间没有公开材料可推可取，两个按钮只会报错）。
                ⚠️ 覆盖默认**关着**：闷头覆盖可能让本机打不开自己的空间（见 Rust 侧注释）。 */}
            {encrypted && (
              <details className="space-privacy-more">
                <summary>换设备（推 / 取公开材料）</summary>
                <div>
                  <div className="space-privacy-hint">
                    旧设备「推到服务器」→ 新设备「从服务器取回」＋输主口令；公开材料里没有裸钥匙。
                  </div>
                  <div className="space-privacy-actions">
                    <button
                      className="sync-btn ghost"
                      disabled={busy === v.space_id}
                      onClick={() =>
                        void runKeyring(v.space_id, "推到服务器", () => api.pushSpaceKeyring(v.space_id))
                      }
                    >
                      推到服务器
                    </button>
                    <button
                      className="sync-btn ghost"
                      disabled={busy === v.space_id}
                      onClick={() =>
                        void runKeyring(v.space_id, "从服务器取回", () =>
                          api.pullSpaceKeyring(v.space_id, allowOverwrite),
                        )
                      }
                    >
                      从服务器取回
                    </button>
                    <label className="space-privacy-overwrite">
                      <input
                        type="checkbox"
                        checked={allowOverwrite}
                        onChange={(e) => setAllowOverwrite(e.target.checked)}
                      />
                      允许覆盖本机已有的材料
                    </label>
                  </div>
                </div>
              </details>
            )}
            {rowMsg?.id === v.space_id && (
              <div className={`space-privacy-gate is-${rowMsg.kind === "ok" ? "allow" : "block"}`}>
                {inlineMd(rowMsg.text)}
              </div>
            )}
            {confirming === v.space_id && (
              <div className="space-privacy-gate is-block">
                关掉加密会把<b>这一个</b>空间的库换回明文（别的空间不受影响）。再点一次按钮才真的执行。
              </div>
            )}
          </div>
        );
      })}

      {/* 主口令：**标签一行、输入框单独一行**（挤在同一行时标签被折行、输入框被压到最右边）。
          说明并进标签里 —— 它只对"第一次开启加密"有用，不值得再占一行。 */}
      <label className="space-privacy-pass">
        主口令（第一次开启加密时设定；忘了就打不开）
        <input
          className="sync-input"
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="至少 8 位"
          aria-label="主口令"
        />
      </label>

      {note && <div className="space-privacy-note">{note}</div>}
      {err && <div className="space-privacy-err">{inlineMd(err)}</div>}
    </section>
  );
}
