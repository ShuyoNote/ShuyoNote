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
import type {
  PairingExportOutcome,
  PairingImportOutcome,
} from "../lib/platform/commands";
import { isDesktopPlatform, platform } from "../lib/platform";
import { inlineMd } from "../lib/inlineMd";
import { refreshVault } from "../lib/vault";

// ⚠️ **2026-10-08 去掉**：这里原来有个 `KIND_LABEL: Record<SpaceKind, string>`（个人空间／团队空间）——
//   它只服务名字行上那枚**徽章**，而徽章与下面的下拉是**同一个字段的两份显示** ⇒ 一起删了 ✓
//   （owner：「圈红的控件是不是可以去掉」✓；⛔ 别加回来，判据钉着那枚徽章必须不存在 ✓）。

/**
 * ★ "开启加密前先勾一下"这个前置：**为什么还在**（`ackNoRecovery`，owner 2026-09-25 拍板 A2）。
 *
 * 零知识：主口令**只在本机**派生出钥匙，我们没有它、也没有第二把备份钥匙 ⇒
 * 「忘记口令」不是"重置一下"，是**这个空间的数据永久打不开**。
 *
 * ⚠️ ⭐ **2026-10-08（owner：「去掉这个文案」✓）**：原先这里还有一条导出常量
 * `PASSPHRASE_NO_RECOVERY`（红字一整句「主口令忘了就**真的打不开了**：……没有找回、没有重置、
 * 没有客服。」），**已删** —— 那句文案按 owner 的要求去掉，⛔ 不许有人顺手加回来。
 * ⚠️ **但勾选前置（`ackNoRecovery`）保留**：它的标签「我已保管好主口令，知道它丢了就打不开」
 * 本身就是那句话的意思 ⇒ 去掉的只是那句**红字文案**，不是"先确认再开启"这件事。
 * 判据（`SpacePrivacySection.test.ts` ⑪⑫）两半都钉着：那句红字**不许再出现** ✓ ＋
 * **没勾时「开启加密」仍是灰的、点了也不调 api** ✓。
 */

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
  // ★ A2（owner 2026-09-25 拍板）：**"我知道口令我记不住就没了"** —— 按空间记（可能同时开着好几个）。
  // 默认 false ⇒ 「开启加密」按钮是灰的，用户必须先把这句话读完、勾上，才点得动。
  const [ackNoRecovery, setAckNoRecovery] = useState<Record<string, boolean>>({});
  // B 片 ①-a（2026-09-25）：**不经服务器**的换设备（配对码）。
  // ⚠️ 它是**整个钥匙袋**级的动作（载荷里带全部空间）⇒ 放在 map 之外，只渲染一份。
  const [pairBusy, setPairBusy] = useState(false);
  const [pairExport, setPairExport] = useState<PairingExportOutcome | null>(null);
  const [pairImport, setPairImport] = useState<PairingImportOutcome | null>(null);
  const [pairText, setPairText] = useState("");
  const [pairCode, setPairCode] = useState("");

  // B 片 ①-a：产出侧（生成配对码）。
  const runPairExport = async () => {
    setPairBusy(true);
    setErr("");
    setNote("");
    try {
      setPairExport(await api.pairingExport());
    } catch (e) {
      setErr(String(e));
    } finally {
      setPairBusy(false);
    }
  };

  // B 片 ①-a：采纳侧。
  // ⚠️ 比对码只在用户真的填了的时候才传 —— 传了后端就**必须**逐位相同（防「换码」的那一步）。
  const runPairImport = async (overwrite: boolean) => {
    setPairBusy(true);
    setErr("");
    setNote("");
    const code = pairCode.trim();
    try {
      setPairImport(
        await api.pairingImport({
          text: pairText,
          confirmed_check_code: code === "" ? undefined : code,
          overwrite,
        }),
      );
    } catch (e) {
      setErr(String(e));
    } finally {
      setPairBusy(false);
    }
  };

  /// ★ B 片 ①-a 的"存/读文件"那一半：把那段配对码存成文件（默认名里带**比对码**，
  /// 这样两台设备对不上时一眼能看出传错了哪一份）。
  const savePairToFile = async () => {
    if (!pairExport) return;
    try {
      const path = await platform.dialog.save({
        title: "保存配对码",
        defaultPath: `shuyonote-pair-${pairExport.check_code}.txt`,
        filters: [{ name: "文本", extensions: ["txt"] }],
      });
      if (!path) return; // 用户取消：什么都不做（**不报错**）
      await api.writeTextFile(typeof path === "string" ? path : path[0], pairExport.text);
      setNote("配对码已存成文件：把它交给新设备（U 盘 / 共享目录都行），在那边点「从文件读取」。");
    } catch (e) {
      setErr(`存文件失败：${String(e)}`);
    }
  };

  /// 从文件里读回一段配对码，填进下面的文本框（**不自动采纳** —— 采纳永远要人点第二步）。
  const loadPairFromFile = async () => {
    try {
      const picked = await platform.dialog.open({
        title: "选择配对码文件",
        multiple: false,
        filters: [{ name: "文本", extensions: ["txt"] }],
      });
      if (!picked) return;
      const path = Array.isArray(picked) ? picked[0] : picked;
      const text = await api.readTextFile(path);
      setPairText(text);
      setNote("已读入配对码——请核对上面旧设备显示的比对码，一致再点「核对并采纳」。");
    } catch (e) {
      setErr(`读文件失败：${String(e)}`);
    }
  };

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
      // ★ 2026-09-25（真机缺陷，MIX 2）：`reload()` 只刷新**本节自己的视图**，而「会话锁定」整节
      // 由 `SettingsDialog` 里的 `useVault().enabled`（＝**内核读数**）控制 ⇒ 少了这一句，开/关加密
      // 成功后那一节**要等重启才出现/消失**（现场：靠重启才拿到「立即锁定」）。
      // 判据：`SpacePrivacySection.test.ts` 里「开启加密成功后 ⇒ 状态中枢必须跟着变」。
      await refreshVault();
    } catch (e) {
      // ⚠️ **原样**显示后端那句话：它本来就是可操作的（说清下一步该做什么）。
      //    自己改写一遍＝把"可操作"抄第二份，两份迟早漂。
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
      {/* ⚠️ **2026-10-04 改**（owner：未分类按个人处理、去掉未分类这一条）：
          ⭐ 原来这句是「个人空间要先加密才能绑同步；未分类的放行但闸门没管到」✗ —— 那两条口径都废了 ✓
          ⇒ 现在只有一条结论：⭐ 只有团队空间能绑服务器 ✓。
          ⚠️ **这句里不许出现连续两个星号** ✗ —— 它是**纯文本**（不过 `inlineMd` ✓），
          而测试里有一条全局断言在钉"界面上不许露 markdown 星号" ✓ ⇒ 一写就红 ✓。 */}
      <div className="space-privacy-hint">
        只有团队空间能绑同步服务器。个人空间不经过服务器，走「附近设备直连」：填一个配对暗号就行。
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
              {/* ⭐ **2026-10-08 去掉**（owner：「圈红的控件是不是可以去掉」✓）：这里原来还有一枚
                  「个人空间／团队空间」**徽章**（`.space-privacy-kind`）✗ —— 它与下面那个下拉
                  （`aria-label="空间分类"`，`value={v.kind}`）是**同一个字段的两份显示** ⇒ 纯重复 ✓。
                  ⚠️ 旁边的 `.space-privacy-enc`（明文／已加密）**留着** —— 下拉里没有加密状态，
                  它不是重复 ✓。⛔ 别把那枚徽章加回来（判据钉着 `querySelector(".space-privacy-kind") === null`）。 */}
              <span className="space-privacy-enc">{encrypted ? "已加密" : "明文"}</span>
              {/* ⚠️ **2026-10-04 去掉**（owner 选的方向：那一块整个拿掉）：
                  ⭐ 原来这里有个「裁决」徽标（✅ 可以绑同步 / ⛔ 不能绑同步 / ⚠️ 闸门没管到）✗ ——
                  ⭐ 现在没有"闸门"这一层了 ✓：只有团队空间能绑服务器 ✓，而那件事由**绑服务器那个动作**
                  （`set_sync_profile`）当场报错 ✓ ⇒ ⭐ 报错落在用户按下"绑定"的那一刻、就在同一屏 ✓。
                  ⭐ 分类本身仍然要能改 ⇒ 下面那个下拉保留 ✓（它是"把这个空间标成团队"的唯一入口 ✓）。 */}
            </div>
            {/* ⚠️ **2026-10-04 去掉**：原来被拦时会在这里占一行（后端给的可操作原因 ✗）。
                ⭐ 现在没人拦了 ⇒ 这一行没有存在意义 ✓（真拦在绑服务器那一刻当场报错 ✓）。 */}
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
                <option value="personal">个人空间（不经过服务器，只走附近设备直连）</option>
                <option value="team">团队空间（可以绑同步服务器）</option>
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
                <>
                  {/* ★ A2：**先勾、再点** —— 那个勾选框是"开启加密"的前置（`ackNoRecovery`）。
                      ⚠️ 2026-10-08（owner：「去掉这个文案」✓）：原先这里上面还有一行**红字提醒**
                      （`PASSPHRASE_NO_RECOVERY`），已删 —— 那句真话现在只由勾选框的标签承担 ✓
                      （⛔ 别把那行红字加回来：判据明确钉着"它不许再出现"）。 */}
                  <label className="space-privacy-overwrite">
                    <input
                      type="checkbox"
                      aria-label="我已保管好主口令"
                      checked={ackNoRecovery[v.space_id] === true}
                      onChange={(e) =>
                        setAckNoRecovery((m) => ({ ...m, [v.space_id]: e.target.checked }))
                      }
                    />
                    我已保管好主口令，知道它丢了就打不开
                  </label>
                  <button
                    className="sync-btn"
                    disabled={busy === v.space_id || ackNoRecovery[v.space_id] !== true}
                    onClick={() =>
                      void run(v.space_id, "开启加密", () =>
                        api.enableSpaceEncryption(v.space_id, pass || undefined),
                      )
                    }
                  >
                    开启加密
                  </button>
                </>
              )}
            </div>
            {/* ★ owner 第三轮拍板（2026-09-24）：原先这里还有 ① 的两个按钮
                （「把旧钥匙迁进钥匙袋」/「换成真随机钥匙」）。那两条命令与它们背后的整套
                应用级加密一起删掉了 ⇒ 不再有"把旧钥匙搬进袋子"这条出路。
                现在"密文库 ＋ 袋里没有它的盒子"（应用级加密的存量库）唯一的出路是**从别处取回
                公开材料**（下面「换设备（不经服务器：配对码）」那块；报错那句说的就是它）。
                ⚠️ 2026-09-29 追改：这里原先还有「推到服务器 / 从服务器取回」两个按钮 ——
                那条**经服务器搬钥匙袋**的路已按 owner 裁定（**同步服务器不提供个人版**）整条删掉，
                "换设备"只剩下面那块**不经服务器**的配对码（依据 `docs/plans/2026-09-29-server-sync-redundancy-inventory.md` 的 A-3 / A-4）。 */}
            {confirming === v.space_id && (
              <div className="space-privacy-gate is-block">
                关掉加密会把<b>这一个</b>空间的库换回明文（别的空间不受影响）。再点一次按钮才真的执行。
              </div>
            )}
          </div>
        );
      })}

      {/* B 片 ①-a（2026-09-25）：**不经服务器**的换设备 —— 一段可以复制/粘贴（或存成文件再传）的配对码。
          ⚠️ 它是**钥匙袋级**的动作（载荷带全部空间）⇒ 只渲染一份，放在 per-space 的 map 之外。
          ⚠️ 这条路不做「6 位短码」：那需要 PAKE（要往客户端加一个密码学实现）。
          防「换码」靠**比对码**：两端各显示同一串数字，人核对一致再采纳；填进下面的框里就是真的核过了。 */}
      <details className="space-privacy-more">
        <summary>换设备（不经服务器：配对码）</summary>
        <div>
          <div className="space-privacy-hint">
            两台设备都在手上时用这条：旧设备「生成配对码」→ 把那段文本交给新设备（复制粘贴，或存成文件再传）
            → 新设备贴进来「核对并采纳」。<b>全程不经过服务器。</b> 这段码不是秘密，但请只交给你自己那台设备。
          </div>
          <div className="space-privacy-actions">
            <button className="sync-btn ghost" disabled={pairBusy} onClick={() => void runPairExport()}>
              生成配对码
            </button>
            {/* ★ B 片 ①-a 的"存/读文件"那一半（2026-09-25）：<b>两台设备不在同一屏时</b>，
                复制粘贴要走一遍"发给自己"（邮件/IM/网盘），而**存成文件再传**是本地优先那条路
                （U 盘/共享目录/直接拖过去）—— 两条都给，别替用户选。
                ⚠️ 存出来的是**明文载荷**（里面没有裸钥匙，但有每空间的盒子密文）⇒ 提示语里说清
                "这不是秘密，但只交给自己的设备"（与上面那句同一口径）。 */}
            <button
              className="sync-btn ghost"
              disabled={pairBusy || !pairExport}
              onClick={() => void savePairToFile()}
            >
              存成文件
            </button>
            <button className="sync-btn ghost" disabled={pairBusy} onClick={() => void loadPairFromFile()}>
              从文件读取
            </button>
          </div>
          {pairExport && (
            <div className="space-privacy-hint">
              <div>
                <b>比对码</b>（另一台上必须对得上）：<code>{pairExport.check_code}</code>
              </div>
              <div>{inlineMd(pairExport.message)}</div>
              <textarea
                readOnly
                value={pairExport.text}
                rows={4}
                className="sync-input space-privacy-pairtext"
                aria-label="配对码"
              />
              {pairExport.qr_svg && (
                <div>
                  <div>用另一台设备的<b>系统相机</b>扫这张码，扫出来的就是上面那段文本：</div>
                  <img
                    className="space-privacy-qr"
                    alt="配对码二维码"
                    src={"data:image/svg+xml;charset=utf-8," + encodeURIComponent(pairExport.qr_svg)}
                  />
                </div>
              )}
            </div>
          )}
          <hr />
          <div className="space-privacy-hint">新设备：把旧设备给的那段文本贴进来，并填上它的比对码。</div>
          <textarea
            value={pairText}
            onChange={(e) => setPairText(e.target.value)}
            rows={4}
            placeholder="粘贴配对码…"
            className="sync-input space-privacy-pairtext"
            aria-label="粘贴配对码"
          />
          <input
            className="sync-input"
            value={pairCode}
            onChange={(e) => setPairCode(e.target.value)}
            placeholder="比对码（填了就必须逐位对得上）"
            aria-label="比对码"
          />
          <div className="space-privacy-actions">
            <button
              className="sync-btn ghost"
              disabled={pairBusy || pairText.trim() === ""}
              onClick={() => void runPairImport(false)}
            >
              核对并采纳
            </button>
            {pairImport?.outcome === "already_local" && (
              <button className="sync-btn ghost" disabled={pairBusy} onClick={() => void runPairImport(true)}>
                我确认，覆盖本机
              </button>
            )}
          </div>
          {pairImport && <div className="space-privacy-hint">{inlineMd(pairImport.message)}</div>}
        </div>
      </details>

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
