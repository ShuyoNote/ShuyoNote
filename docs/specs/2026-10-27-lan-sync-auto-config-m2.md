# 局域网同步：用户进入页面即自动备好（M2）

- 状态：**已实现**（2026-10-27，owner 拍 M2）
- 证据：`src-tauri/src/sync.rs` 的 `mesh_ensure_defaults` 命令 ／ `src/components/SyncPanel.tsx` 的首进自动备好与开/关按钮 ／ `src/components/syncPanelMesh.wiring.test.ts` 的 ① / ①c / ③
- 相关：`docs/specs/2026-09-29-nearby-devices-spec.md`（附近设备与配对）、`docs/specs/2026-10-09-multidevice-merge-semantics.md`（按名融合）

## 1. 它解决的是什么（真机现场）

**全新档案 / 清过数据的桌面用户**：库里没有 `mesh_bind` ⇒ 网格这一档没开；而

1. 桌面**不会自动配**（`ensure_mobile_mesh_defaults` 只在 `#[cfg(mobile)]` 下被启动路径调用，
   注释逐字「桌面版保持『用户不配就不广播』」）；
2. 桌面面板自 **2026-10-14** 删掉「设备直连设置卡」后**没有改监听地址的入口**
   （`MeshAdvancedForm.tsx` 已删；`SyncPanel.tsx` 的注释逐字「界面上再也没有改监听地址的地方」
   「界面上再也没有『关掉网格』」）。

⇒ 结果：状态条两格显示「未读到」、第三格是 `reach`「还没开 ⇒ 别人拉不到」。
⚠️ 这**不是** 2026-10-26 修的那个"已配置但读错键"的假未读到（那笔见 `pick_lan_scope` 的注释）；
这里是真的没配。

## 2. 口径（M2）

```text
① 用户**第一次进入「局域网同步」页**时，才把局域网前置备好（设备身份／自动组名／监听地址／档案行）；
   ⛔ 不在启动时自动写 —— 桌面「用户不配就不广播」那条隐私口径**一个字不改**。
② 备好是**幂等、只补不覆盖**的：已有值的格子一个字节不改（用户手设的组名/地址永远不动）。
③ 本机**只自动跑一次**（localStorage `shuyo.lan-sync-autoconfig.v1`）——
   用户手动关掉之后，不会下次进页又被自动开回来。
④ 界面给一枚**可逆**开关：「关闭局域网同步」走 `meshSetConfig(ws, "", null)`（空串＝清除；
   后端 `write_setting`/`read_setting` 两侧都按空处理，`config_state.enabled = bind.is_some()` 随之变 false）；
   关闭只清监听地址，**配对/信任关系保留**。
⑤ 桌面"自动组名"的采用（`maybe_adopt_peer_room`）从移动端放开到桌面，但**仍只在
   `mesh_room_auto=1`** 时生效 —— 而桌面那枚标记只可能由本命令写入（＝用户进过这一页）。
```

## 3. 实现落点

| 层 | 落点 | 做什么 |
|---|---|---|
| Rust 命令 | `sync::mesh_ensure_defaults(workspaceId?)` | 调 `ensure_mesh_defaults`（＝移动端那四步的别名，单一实现）后回 `MeshConfigState` 读数 |
| Rust 发现层 | `lan_state::maybe_adopt_peer_room` | 去掉 `#[cfg(mobile)]`；日志改为平台中立 |
| 命令面 | `src/lib/platform/commands.ts` | 新增 `mesh_ensure_defaults` 契约 |
| API | `src/lib/api.ts` | `meshEnsureDefaults(ws?)` |
| Web 桩 | `src/lib/platform/web.ts` | 回"关着 ＋ 为什么"的读数（⛔ 不抛错、⛔ 不假装写了） |
| 面板 | `src/components/SyncPanel.tsx` | 首进自动备好（localStorage 一次性标记）＋ 开/关按钮 ＋ 结果提示 |

## 4. 判据

- `syncPanelMesh.wiring.test.ts`：
  - ①：面板**必须**调 `api.meshEnsureDefaults(`，契约里必须有 `mesh_ensure_defaults:`
  - ①c：一次性标记 `LAN_AUTO_CONFIG_KEY` 在 ／ 已配过（`mesh.bind` 非空）时**一个字节都不写** ／
    `App.tsx` 启动路径**不许**出现 `meshEnsureDefaults` ／ `lib.rs` 里命令注册了、且 setup 里没有新增桌面自动调用
  - ③：关闭走 `api.meshSetConfig(activeId, "", null)`（空串＝清除）
- `pnpm check:web-commands`：Rust 命令 ⊆ CommandMap、web.ts 全部实现
- Rust 侧：`ensure_mesh_defaults` 复用 `mobile_defaults_fill_the_missing_mesh_prerequisites_once`
  与 `mobile_defaults_never_override_configured_values` 两条既有判据（只补不覆盖、幂等）

## 5. 不做（边界）

```text
⛔ 不在启动时自动开（隐私口径不变）—— 反例：App.tsx 调它（判据 ①c 会红）。
⛔ 不恢复旧「设备直连设置卡」：不摆监听地址输入框、不摆口令，只有一枚开关。
⛔ 不改 R208/A 的信任语义：开关只开"网络门"，**不登记任何设备**（登记入口仍只有
   `mesh_trust_begin` / `remember_peer_card` 两处）。
⛔ 不改团队空间（C3）：本命令只补个人档（含未分类的 `default`）。
```

## 6. 真机读数（2026-10-27，临时档案：`SHUYONOTE_DATA_DIR=_tmp/scratch/m2-validate-1027`）

```text
① 全新档案（meta.db 155,648 B）→ 调 `mesh_ensure_defaults`（＝用户第一次进本页做的事）：
   enabled=true ｜ bind=0.0.0.0:8788 ｜ window=http://0.0.0.0:8788 ｜ served=["0492226c…"]
   日志逐字：`[mesh] 网格窗口已启动：0.0.0.0:8788 ｜ 服务 1 个空间：0492226cf5291ce8ea166159244c62e6`
   ＋ `[mesh] 公告：发出 2/2（目标 2 条：受限广播 1 ｜ 回环 1 ｜ 其它 0）｜ 空间 0492…`
   KV（meta.db）：`mesh_room = auto-b81746df0bdb701b`、`mesh_room_auto = 1`
② 外部核端口（非应用自报）：`Get-NetTCPConnection -LocalPort 8788 -State Listen` ⇒ **0.0.0.0:8788 在听**
③ 幂等：第二次调 `mesh_ensure_defaults` ⇒ 读数一个字节不变
④ 关闭：`mesh_set_config(ws, "", null)` ⇒ enabled=false／bind=null／window=null／
   `reach="还没开 ⇒ 别人拉不到"`；**8788 立刻不再监听（计数 0）** ✓
```

⚠️ **仍缺**：**两台机器**的发现 → 配对 → 拉取端到端（本轮没有第二台在线）；手机端行为未回归（本机无 Android/iOS 设备）。
⚠️ 另注：本次验证时同步页是 App **恢复出来的当前视图**（`<SyncPanel contentOnly />` 挂载）
⇒ 等价于"用户已经在这一页"，所以自动备好在启动时就触发了 —— 与 M2 口径一致
（⛔ 不是"启动即配"：没进这一页的档案，一个字节都不会写；见判据 ①c）。
