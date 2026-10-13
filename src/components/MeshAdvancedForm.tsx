// **设备直连的「高级设置」那一块**（监听地址 / 配对暗号 / 关掉网格）—— task 派单 **Round 1：纯抽取**。
// ⭐ **2026-10-13（owner 拍「去掉同步面板那个口令」）**：「口令」那一格**已删** ✗（它还渲染在界面上时
//   用户会按**过时**的认知做决定 ✓）—— ⛔ 后端那格数据**保留可读、不静默删** ✗（`mesh.rs` 未动 ✓）。
//
// ## 为什么抽出来（只为让**下一次**改动变容易 ✓）
// 这三项本来嵌在 `SyncPanel.tsx` 的「设备直连」那一折里（`:1969-2035`）✓，而 owner 拍的图⑧要求它们
// 搬到「设置 · 同步 → 高级」✗。⇒ 先**原地抽成组件**：界面／类名／文案／行为**一个字都不改** ✓
// （四条判据因此仍是"承诺不变、只换落点" ✓），下一轮再把**挂载点**换到设置面 ✓。
//
// ## ⚠️ 边界（这一轮刻意不动）
// · ⛔ 没碰 `SettingsDialog`／i18n／`store/editor.ts`（那些是 Round 2 ✓）
// · ⛔ 语义**仍是"当前空间"**（`activeId` 由外面传 ✓）—— 设置面要不要空间选择器是**产品口径**，
//   归 owner 拍（图⑧读起来像"设备级"，而 `meshSetConfig` 是**逐空间**的 ✓）
// · ⭐ 类名照抄 `.sync-att sync-mesh` ✓（那份 CSS 还在 `App.css` 里、还钉着判据 ⑥ ✓ ⇒ ⛔ 没有第二套平行类 ✓）

import { useEffect, useState } from "react";

import { api, type LanStatus } from "../lib/api";
import { inlineMd } from "../lib/inlineMd";

export interface MeshAdvancedFormProps {
  /**
   * 当前空间。⚠️ 类型**照抄原样**（`string | null` ✓）—— 因为 `api.meshSetConfig(workspaceId?: string | null, …)`
   * 本来就收 `null` ✓（`api.ts:511-517` ✓），改成 `string` 会把面板那边的调用**变红** ✗
   * 且会**偷偷改掉**"没选空间时传 null"这个既有行为 ✓。⇒ ⛔ 不要为了类型好看改语义 ✗。
   */
  activeId: string | null;
  /** 面板/设置面**各自**的那份读数（`:201` 的轮询在面板里 ✓；Round 2 设置面会给自己的 ✓）。 */
  lanStatus: LanStatus;
  /** ⭐ **就地**反馈：面板传它的 `setStatus`、设置面传它自己的 ✓（⛔ 不共享一个全局 ✗）。 */
  onStatus: (text: string) => void;
  /** ⚠️ 保行为用：存「配对暗号」时原先会**顺手把面板那份 `lanStatus.mesh` 就地更新** ✓ ⇒ 这个回调保住它 ✓。 */
  onMeshChanged: (mesh: LanStatus["mesh"]) => void;
}

/** ⭐ **2026-10-13（owner：「地址那格不是应该自动吗？」＋ Lead 核实＋拍板 ✓）**：
 *  「地址自动」那半**已经落地**在 Rust（通配放行 `mesh.rs:3075`；枚举 `announced_base mesh.rs:1509`
 *  ＋ `announced_bases_with_named`（WLAN 排第一）✓；`is_unspecified` 分支 `:1232` ✓）；
 *  ⚠️ 缺的只是**前端那两下**：默认值是空 ✗、且要"先填再保存"两步 ✗。
 *  ⭐ 所以这里只做两件（⛔ 不碰协议、⛔ 不改后端那条"默认是关的"判据 `mesh.rs:4067` ✗）：
 *   ① 没保存过时**预填**这个建议值 ✓（只是让人看见，⛔ 不落库 ✗）；
 *   ② 给一颗**一键**（`enableAutoBind` ✓）⇒ 一下就开起来 ✓。
 *  ⚠️ 为什么**不**把网格改成"默认自动开" ✗：绑通配＝**监听所有网卡** ✓ ⇒ 未经用户动作就自动开
 *    属**安全相关默认值** ✗ ⇒ 本仓规矩"默认值只取零风险" ✓；而设计里的 U6
 *    「配对后重启两台 ⇒ 无需任何操作即同步」在**保存过之后**已经满足 ✓（窗口在**进程启动**时开 ✓
 *    `lan_state.rs:748` ✓）。⚠️ U6 的**真机**端到端（重启两台）只归 **P5** ✗ —— loopback 证不了 ✓。
 */
export const AUTO_MESH_BIND = "0.0.0.0:8788";

/** 设备直连的三个手填项 ＋ 四个按钮（图⑧ 要把这一块搬去「设置 · 同步 → 高级」）。 */
export function MeshAdvancedForm({ activeId, lanStatus, onStatus, onMeshChanged }: MeshAdvancedFormProps) {
  // ⭐ 预填建议值（⛔ 不落库 ✗）：没保存过时也让人**看见**该填什么 ✓（原来这里是 `""` ✗）。
  const [meshBind, setMeshBind] = useState(AUTO_MESH_BIND);
  // ⚠️ **2026-10-04 加**（owner：个人空间也要能用设备直连）：⭐ 配对暗号 ✗。
  // ⭐ 网格要一个「两边填一样」的字符串来对暗号 ✓，而个人空间**没有** `space_id`（那在服务器上）
  // ⇒ 这一项就是它的替身 ✓；⭐ 团队空间里 `space_id` 优先 ⇒ 填不填都不影响 ✓。
  const [meshRoom, setMeshRoom] = useState("");
  const [meshBusy, setMeshBusy] = useState(false);
  const meshSavedBind = lanStatus.mesh.bind ?? "";
  // 只在**读数里的值变了**时回填：用户正在输入时轮询到的是同一份值 ⇒ 不会覆盖他打的字。
  // ⭐ 2026-10-13：读数里**没有**保存过（`""`）⇒ 回填**建议值** ✓（⛔ 不是空 ✗ —— 空的那格
  //   正是 owner 那句「不是应该自动吗？」看到的样子 ✓）。
  useEffect(() => {
    setMeshBind(meshSavedBind || AUTO_MESH_BIND);
  }, [meshSavedBind]);

  const saveMeshBind = async () => {
    setMeshBusy(true);
    try {
      const st = await api.meshSetConfig(activeId, meshBind.trim(), null);
      onStatus(st.note);
    } catch (e) {
      onStatus(`网格设置没保存：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMeshBusy(false);
    }
  };

  /**
   * ⭐ **一键**（owner：「地址那格不是应该自动吗？」✓）：用**通配**把网格开起来 ✓。
   *
   * ⚠️ 与「保存地址」**同一个命令、同一套参数** ✓（`meshSetConfig(activeId, 通配, null)` ✓ ——
   *   `null` ＝ 不动「配对暗号」那一项 ✓，与 `api.ts:511-517` 同口径 ✓）；差别只是**它自己带值** ✓
   *   ⇒ 用户不必先知道该填什么 ✓。
   * ⛔ 它**不**改任何后端默认值 ✗（默认仍是关的 ✓）：这一下**就是**用户的那次动作 ✓。
   */
  const enableAutoBind = async () => {
    setMeshBusy(true);
    try {
      const st = await api.meshSetConfig(activeId, AUTO_MESH_BIND, null);
      setMeshBind(AUTO_MESH_BIND);
      onStatus(st.note);
    } catch (e) {
      onStatus(`网格设置没保存：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMeshBusy(false);
    }
  };

  /** ⭐ 存「配对暗号」：个人空间两台设备填同一个就能互连（团队空间不受影响 ✓）。 */
  const saveMeshRoom = async () => {
    if (!meshRoom.trim()) return;
    setMeshBusy(true);
    try {
      // ⚠️ 只写 room 这一项 ⇒ 另两项传 `null`（＝不动 ✓，与 Rust 侧同口径 ✓）。
      const st = await api.meshSetConfig(activeId, null, null, meshRoom.trim());
      onMeshChanged(st);
      onStatus(
        "配对暗号已保存。到另一台设备上填「同一个」暗号，两台在同一个网络里就能直接连上，不经过服务器",
      );
    } catch (e) {
      onStatus(String(e));
    } finally {
      setMeshBusy(false);
    }
  };

  const disableMesh = async () => {
    setMeshBusy(true);
    try {
      // `""` ＝ **清除监听地址** ⇒ 网格关掉、窗口立刻松口（与命令面同一套口径）。
      const st = await api.meshSetConfig(activeId, "", null);
      onStatus(st.note);
    } catch (e) {
      onStatus(`网格没关掉：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMeshBusy(false);
    }
  };

  return (
    <div className="sync-att sync-mesh">
      <span className="sync-att-text">
        {/* ★ 2026-09-26 口径收敛：**地址不在这里说第二遍** —— 窗口地址与"别人拉不拉得到"
            已经在面板底部那一行"设备直连"里（由 Rust 出原文的**那一处读数**）。这一块只管**设置**
            （监听地址 / 配对暗号）与开关 —— ⭐ 「口令」那一格**已于 2026-10-13 删掉** ✓（它已退役 ✗）。
            ⚠️ 这里**故意不写那处读数的字段名** ✗：`syncControls.wiring.test.ts` ⑤ 会扫这一块
            「不许再出现它」✓（那份判据现在读**本文件** ✓）⇒ 写了就会把它判红 ✓。 */}
        {/* ★ VL-3（2026-09-30）：**"功能通了，而普通用户不知道有这条路"** —— VL-2 让
            `0.0.0.0` 能填了，而这一栏原先只说"填虚拟网卡的地址" ⇒ "地址自动"在用户眼里
            没发生。⇒ 两条路都写在**看得见**的文案里（不只在 hover 提示与 placeholder 里）。 */}
        <span className="sync-hint">
          {inlineMd("填 **本机内网地址**（如 192.168.1.5:8788），或 **0.0.0.0:8788**（**听所有网卡**，地址由**系统报出**）。")}
          <br />
          {/* ⭐ **2026-10-13（owner 拍「去掉同步面板那个口令」＋ Lead 核实 ✓）**：
              那两句旧文案（「**它是这个空间的唯一防线**」／「**没设 = 不设防**」）与后端**直接冲突** ✗
              ⇒ 一并换掉 ✓。⭐ 事实（逐字）：
              · `mesh.rs:787`「⛔ 不是用户手打的口令 ✗（用户手打的那条 `mesh_token` **已经退役** ✓）」；
              · `mesh.rs:1727`「旧的 `mesh_token:<space>` KV **保留可读**（不静默删 ✓）但**不再作任何凭证** ✗」；
              · 门今天在用的两档＝ ⭐ **配对密钥的 sha256（Bearer）** ＋ ⭐ **真公钥签名** ✓。
              ⚠️ ⛔ **也不许反过来写"完全没防护"** ✗ —— "未加密空间 ＋ 无配对密钥"时的实际判定链**还没核完** ✓
              （核不清就不下结论 ✓）；⛔ 后端那格数据**保留可读、不静默删** ✗（本片只动界面 ✓）。 */}
          {inlineMd("**口令已不再用于鉴权** —— 门只认**配对密钥**与**设备签名**两档；旧口令留在库里只作可读记录，不参与判定。")}
        </span>
        {/* 交换**并进「同步」**，这里不再有自己的按钮（同一件事原本两个按钮、用户要记两个动作）。*/}
      </span>
      <div className="sync-field">
        <input
          className="sync-input"
          placeholder="监听地址：如 192.168.1.5:8788；或 0.0.0.0:8788（听所有网卡，地址由系统报出）"
          value={meshBind}
          disabled={meshBusy}
          onChange={(e) => setMeshBind(e.target.value)}
        />
        <button className="sync-btn" disabled={meshBusy || !meshBind.trim()} onClick={() => void saveMeshBind()}>
          保存地址
        </button>
      </div>
      {/* ⭐ 2026-10-13（owner 问「不是应该自动吗？」✓）：**一键** ✓ —— 文案要把"这一下到底发生了什么"
          说清 ✓（Lead 逐字：绑通配 ⇒ 听所有网卡，报出去的地址由系统枚举（换网不用改）✓）。 */}
      <div className="sync-field">
        <button
          className="sync-btn"
          data-testid="mesh-auto-enable"
          disabled={meshBusy}
          onClick={() => void enableAutoBind()}
        >
          用自动选开启
        </button>
        <span className="sync-hint">
          {inlineMd(
            "**绑 0.0.0.0:8788 ⇒ 听所有网卡**：**报出去的地址由系统枚举**（**换网不用改**）✓ —— 一下点开；⛔ 默认仍是关的 ✗（开了才会监听所有网卡 ✓）。",
          )}
        </span>
      </div>
      <div className="sync-field">
        <input
          className="sync-input"
          placeholder="配对暗号：两台设备填得一模一样（例如：我的两台电脑）"
          value={meshRoom}
          disabled={meshBusy}
          onChange={(e) => setMeshRoom(e.target.value)}
        />
        <button className="sync-btn" disabled={meshBusy || !meshRoom.trim()} onClick={() => void saveMeshRoom()}>
          保存暗号
        </button>
      </div>
      <div className="sync-field">
        <button className="sync-btn" disabled={meshBusy || !lanStatus.mesh.enabled} onClick={() => void disableMesh()}>
          关掉网格
        </button>
      </div>
    </div>
  );
}
