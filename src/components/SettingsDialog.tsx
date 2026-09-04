import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { useEditorStore, type SettingsTab } from "../store/editor";
import { ACCENTS, useTheme, type Theme } from "../store/theme";
import { AiSettingsForm } from "./AiSettingsForm";
import { BackupButton } from "./BackupButton";
import { StoragePanel } from "./StoragePanel";
import { usePlugins } from "../store/plugins";
import { api } from "../lib/api";
import type { SyncProfile } from "../lib/api";
import { isDesktopPlatform } from "../lib/platform";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import { inputDialog } from "../store/input";
import { useSpaceStore } from "../store/space";
import { useWindowChrome } from "../store/windowChrome";
import { useNotes } from "../store/notes";
import { useAuth } from "../store/auth";
import { exportCurrentSpace, importSpacePackage, removeSpace } from "../lib/spaceTransfer";
import { APP_VERSION, APP_LICENSE } from "../lib/links";
import {
  PaletteIcon,
  FolderIcon,
  PersonIcon,
  DatabaseIcon,
  TemplateIcon,
  LockIcon,
  SparkleIcon,
  InfoIcon,
} from "./icons";

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "亮色" },
  { id: "dark", label: "暗色" },
];

const TABS: { id: SettingsTab; labelKey: string; hintKey: string; icon: JSX.Element }[] = [
  { id: "appearance", labelKey: "settings.appearance", hintKey: "settings.appearanceHint", icon: <PaletteIcon width={16} height={16} /> },
  { id: "spaces", labelKey: "settings.spaces", hintKey: "settings.spacesHint", icon: <FolderIcon width={16} height={16} /> },
  { id: "account", labelKey: "settings.account", hintKey: "settings.accountHint", icon: <PersonIcon width={16} height={16} /> },
  { id: "data", labelKey: "settings.data", hintKey: "settings.dataHint", icon: <DatabaseIcon width={16} height={16} /> },
  { id: "plugins", labelKey: "settings.plugins", hintKey: "settings.pluginsHint", icon: <TemplateIcon width={16} height={16} /> },
  { id: "security", labelKey: "settings.security", hintKey: "settings.securityHint", icon: <LockIcon width={16} height={16} /> },
  { id: "ai", labelKey: "settings.ai", hintKey: "settings.aiHint", icon: <SparkleIcon width={16} height={16} /> },
  { id: "about", labelKey: "settings.about", hintKey: "settings.aboutHint", icon: <InfoIcon width={16} height={16} /> },
];

// 每页一句话说明，放在内容区页头——比只有一个标题更有分量，也省去用户猜
// 「这一页到底管什么」。
// 「数据」页：全库备份/恢复与存储清理——低频、全局、不可逆，按判据归设置。
// 两个组件都用 `label` 变体渲染成带文字的按钮，实现与侧栏时期完全共用。
function DataPane() {
  return (
    <>
      <section className="set-section">
        <div className="set-section-title">完整备份</div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name">备份 / 恢复（全库）</div>
            <div className="set-row-sub">
              导出所有空间与附件为一个包；导入为**合并**，不会覆盖现有空间。
            </div>
          </div>
          <BackupButton label="备份 / 恢复…" />
        </div>
        <p className="set-hint">
          单个空间的导出/导入在「空间」页；这里是整机全库级别的备份。
        </p>
      </section>

      <section className="set-section">
        <div className="set-section-title">存储与清理</div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name">存储 / 空间管理</div>
            <div className="set-row-sub">
              查看数据库 / 附件 / 回收站 / 版本历史的占用构成，并回收可释放空间
            </div>
          </div>
          <StoragePanel label="打开…" />
        </div>
      </section>
    </>
  );
}

// 空间配色候选（与侧栏空间弹层同一组色值）。
const SPACE_ACCENTS = [
  "#3370FF", "#00B578", "#FF8A1E", "#7B61FF", "#00A9C7", "#D9A300", "#F54A45", "#646A73",
];

function hostLabel(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || url || "(未设置服务器)";
  }
}

// 「空间」页：低频且有破坏性的空间管理（配色 / 删除 / 导出 / 导入）。
// 高频的「切换空间」仍留在侧栏——它是工作流入口，不是设置。
function SpacesPane() {
  const spaces = useSpaceStore((s) => s.spaces);
  const activeId = useSpaceStore((s) => s.activeId);
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 每个空间的同步目标：让「这个空间到底同不同步、同步到哪」在管理页就能看到，
  // 不用再切回同步面板逐个点开。
  const [syncProfiles, setSyncProfiles] = useState<Record<string, SyncProfile>>({});
  const activeName = spaces.find((s) => s.id === activeId)?.name ?? "当前空间";

  useEffect(() => {
    api
      .listSyncProfiles()
      .then((list) => {
        const byWs: Record<string, SyncProfile> = {};
        for (const p of list) byWs[p.ws_id] = p;
        setSyncProfiles(byWs);
      })
      .catch(() => {});
  }, [spaces.length]);

  const setColor = async (id: string, color: string) => {
    setColorFor(null);
    const ok = await useSpaceStore.getState().setSettings(id, color);
    if (!ok) toast("设置颜色失败", "error");
  };

  const doRemove = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: "删除工作空间",
      message: `删除「${name}」及其所有内容？建议先导出/备份（软删除，可在数据目录恢复）。`,
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await removeSpace(id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="set-section">
        <div className="set-section-title">全部空间（{spaces.length}）</div>
        <div className="set-space-list">
          {spaces.map((s) => {
            const active = s.id === activeId;
            const prof = syncProfiles[s.id];
            return (
              <div key={s.id} className={`set-space-card${active ? " is-active" : ""}`}>
                <div className="set-space-row">
                  <span
                    className="set-space-mark"
                    style={s.theme ? { background: s.theme, color: "#fff" } : undefined}
                  >
                    {s.name.charAt(0)}
                  </span>
                  <div className="set-row-text">
                    <div className="set-row-name">
                      {s.name}
                      {active && <span className="set-tag">当前</span>}
                    </div>
                    <div className="set-space-meta">
                      {prof?.server_url ? (
                        <span className="set-space-sync">↔ {hostLabel(prof.server_url)}</span>
                      ) : (
                        <span className="set-space-local">仅本机</span>
                      )}
                      <span className="set-space-id" title={s.id}>{s.id.slice(0, 8)}</span>
                    </div>
                  </div>
                  <button
                    className={`set-btn${colorFor === s.id ? " is-on" : ""}`}
                    onClick={() => setColorFor((c) => (c === s.id ? null : s.id))}
                  >
                    配色
                  </button>
                  <button
                    className="set-btn is-danger-ghost"
                    disabled={busy || spaces.length <= 1 || active}
                    title={active ? "当前空间不可删除，请先切换到别的空间" : spaces.length <= 1 ? "至少保留一个空间" : "删除该空间"}
                    onClick={() => doRemove(s.id, s.name)}
                  >
                    删除
                  </button>
                </div>
                {colorFor === s.id && (
                  <div className="set-space-colors">
                    <span className="set-space-colors-label">空间颜色</span>
                    <div className="set-swatch-row">
                      {SPACE_ACCENTS.map((c) => (
                        <button
                          key={c}
                          className={`set-swatch${s.theme === c ? " is-on" : ""}`}
                          style={{ background: c }}
                          aria-label={`使用颜色 ${c}`}
                          onClick={() => setColor(s.id, c)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="set-hint">
          切换空间在侧栏顶部——这里只做低频管理。删除为软删除，数据仍在磁盘上，可在「存储 / 空间管理」里彻底清理。
        </p>
      </section>

      <section className="set-section">
        <div className="set-section-title">单空间迁移</div>
        <div className="set-migrate">
          <div className="set-migrate-card">
            <div className="set-migrate-icon">↑</div>
            <div className="set-migrate-name">导出当前空间</div>
            <div className="set-migrate-sub">「{activeName}」及其引用到的附件，打包成一个 zip</div>
            <button className="set-btn" onClick={() => void exportCurrentSpace(activeName)}>
              导出…
            </button>
          </div>
          <div className="set-migrate-card">
            <div className="set-migrate-icon">↓</div>
            <div className="set-migrate-name">导入空间包</div>
            <div className="set-migrate-sub">始终新建一个空间，绝不覆盖现有空间</div>
            <button className="set-btn" onClick={() => void importSpacePackage()}>
              导入…
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

// 「账户」页：登录身份（低频、全局）。同步操作仍在同步面板——那是高频、
// 需要状态常驻可见的动作。这里只做「我是谁、连了哪些服务器」。
function AccountPane() {
  const spaces = useSpaceStore((s) => s.spaces);
  const { authed, serverUrl, token, email, clear } = useAuth();
  const [groups, setGroups] = useState<{ server_url: string; wss: { ws_id: string; name: string; spaceId: string; token: string }[] }[]>([]);
  const [status, setStatus] = useState("");
  const [syncing, setSyncing] = useState(false);
  // P0 org management state (research group leader). Members are per-org so
  // several groups can coexist without their member lists bleeding into each other.
  const [orgs, setOrgs] = useState<{ id: string; name: string; role: string; owner_id: string }[]>([]);
  const [orgMembers, setOrgMembers] = useState<Record<string, { members: { user_id: string; email: string; role: string; disabled: boolean }[]; pending: { email: string; status: string }[] }>>({});
  const [inviteEmail, setInviteEmail] = useState<Record<string, string>>({});
  const [orgStatus, setOrgStatus] = useState("");
  // 邀请码（每组织一个被生成的码）与「凭码加入」输入。
  const [inviteCodes, setInviteCodes] = useState<Record<string, string>>({});
  const [joinCode, setJoinCode] = useState("");

  const refresh = useCallback(async () => {
    try {
      const profiles = await api.listSyncProfiles();
      const name = new Map(spaces.map((s) => [s.id, s.name]));
      const byServer = new Map<string, { ws_id: string; name: string; spaceId: string; token: string }[]>();
      for (const p of profiles) {
        const key = p.server_url || "(未设置服务器)";
        if (!byServer.has(key)) byServer.set(key, []);
        byServer.get(key)!.push({
          ws_id: p.ws_id,
          name: name.get(p.ws_id) ?? p.ws_id,
          spaceId: p.space_id,
          token: p.token,
        });
      }
      setGroups(Array.from(byServer.entries()).map(([server_url, wss]) => ({ server_url, wss })));
    } catch (e) {
      setStatus(String(e));
    }
  }, [spaces]);

  const logout = async () => {
    if (!serverUrl) return;
    setStatus("");
    try {
      await api.teamLogout(serverUrl);
      // 全局登出：清空所有绑定空间的 sync_token/space_id（保留 server_url 供再登录），
      // 否则标题栏胶囊仍显示旧 token 的同步目标，不会随登出消失。
      const profiles = await api.listSyncProfiles();
      for (const p of profiles) {
        await api.setSyncProfile(p.ws_id, { server_url: p.server_url }).catch(() => {});
      }
      clear();
      setStatus("已登出当前账号");
      await refresh();
    } catch (e) {
      setStatus(`登出失败：${e}`);
    }
  };

  // 注销自己（毕业交接）：账号作废 + 数据交组长。不可逆，需二次确认。
  const deactivateSelf = async () => {
    if (!serverUrl || !token) { setStatus("请先登录团队账号"); return; }
    const ok = await confirmDialog({
      title: "注销账号",
      message: `注销后无法再登录，但你的数据会转交给所属组织的组长。确定注销「${hostLabel(serverUrl)}」上的这个账号？`,
      danger: true,
    });
    if (!ok) return;
    setStatus("");
    try {
      await api.teamDeactivateAccount(serverUrl, token);
      clear();
      setStatus("账号已注销。数据已转交组长。");
      await refresh();
    } catch (e) {
      setStatus(`注销失败：${e}`);
    }
  };

  const syncGroup = async (g: { server_url: string; wss: { ws_id: string }[] }) => {
    setSyncing(true);
    setStatus("");
    try {
      let ok = 0;
      let fail = 0;
      for (const w of g.wss) {
        const r = await api.syncWorkspace(w.ws_id);
        if (r.error) fail++;
        else ok++;
      }
      setStatus(`「${hostLabel(g.server_url)}」同步：成功 ${ok}，失败 ${fail}`);
      await useNotes.getState().loadPages();
    } catch (e) {
      setStatus(String(e));
    } finally {
      setSyncing(false);
    }
  };

  // ---- P0 org management handlers ----
  const base = serverUrl;

  const loadOrgs = useCallback(async (sv: string, tk: string) => {
    try {
      setOrgs(await api.teamListOrgs(sv, tk));
    } catch (e) {
      setOrgStatus(`组织拉取失败：${e}`);
    }
  }, []);

  const createOrg = async () => {
    if (!base || !token) { setOrgStatus("请先登录团队账号"); return; }
    // 用应用内 inputDialog（替代丑的原生 prompt）。
    inputDialog({
      title: "新建组织",
      placeholder: "组织名称",
      defaultValue: "",
      onSubmit: async (name) => {
        const n = name.trim();
        if (!n) return;
        try {
          await api.teamCreateOrg(base, token, n);
          await loadOrgs(base, token);
          setOrgStatus("组织已创建");
        } catch (e) {
          setOrgStatus(`创建失败：${e}`);
        }
      },
    });
  };

  const loadMemberList = useCallback(async (orgId: string) => {
    if (!base || !token) return;
    try {
      const members = await api.teamListOrgMembers(base, token, orgId);
      setOrgMembers((prev) => ({ ...prev, [orgId]: members }));
    } catch (e) {
      setOrgStatus(`成员拉取失败：${e}`);
    }
  }, [base, token]);

  // P0: load orgs on mount / auth change.
  useEffect(() => {
    void refresh();
    if (base && token) void loadOrgs(base, token);
  }, [base, token, refresh, loadOrgs]);

  // Fetch each org's members whenever orgs change. 任一成员可读成员列表（只读），
  // 所以每个组织都拉；但管理操作（邀请/移除/改角色）需 admin（UI 用 o.role 限定）。
  useEffect(() => {
    if (!base || !token) return;
    for (const o of orgs) void loadMemberList(o.id);
  }, [orgs, base, token, loadMemberList]);

  const inviteMember = async (orgId: string) => {
    if (!base || !token) return;
    const email = (inviteEmail[orgId] ?? "").trim();
    if (!email) { setOrgStatus("请输入被邀请者邮箱"); return; }
    try {
      await api.teamInviteOrgMember(base, token, orgId, email, "member");
      setInviteEmail((prev) => ({ ...prev, [orgId]: "" }));
      await loadMemberList(orgId);
      setOrgStatus("已邀请");
    } catch (e) {
      setOrgStatus(`邀请失败：${e}`);
    }
  };

  const approveInvite = async (orgId: string, email: string) => {
    if (!base || !token) return;
    try {
      await api.teamApproveOrgInvite(base, token, orgId, email);
      await loadMemberList(orgId);
      setOrgStatus(`已批准 ${email}`);
    } catch (e) {
      setOrgStatus(`批准失败：${e}`);
    }
  };

  const rejectInvite = async (orgId: string, email: string) => {
    if (!base || !token) return;
    try {
      await api.teamRejectOrgInvite(base, token, orgId, email);
      await loadMemberList(orgId);
      setOrgStatus(`已拒绝 ${email}`);
    } catch (e) {
      setOrgStatus(`拒绝失败：${e}`);
    }
  };

  const toggleActive = async (orgId: string, m: { user_id: string; disabled: boolean }) => {
    if (!base || !token) return;
    try {
      await api.teamSetOrgMemberActive(base, token, orgId, m.user_id, m.disabled);
      await loadMemberList(orgId);
      setOrgStatus(m.disabled ? "已启用" : "已停用");
    } catch (e) {
      setOrgStatus(`状态切换失败：${e}`);
    }
  };

  const removeMember = async (orgId: string, userId: string) => {
    if (!base || !token) return;
    try {
      await api.teamRemoveOrgMember(base, token, orgId, userId);
      await loadMemberList(orgId);
      setOrgStatus("已移除成员（数据保留）");
    } catch (e) {
      setOrgStatus(`移除失败：${e}`);
    }
  };

  // 组长注销组员（毕业交接）：账号作废 + 数据交组长。不可逆，二次确认。
  const deactivateMember = async (orgId: string, userId: string, email: string) => {
    if (!base || !token) return;
    const ok = await confirmDialog({
      title: "注销成员",
      message: `注销「${email}」后其无法再登录，但数据会转交给组长。确定注销该成员？`,
      danger: true,
    });
    if (!ok) return;
    try {
      await api.teamDeactivateOrgMember(base, token, orgId, userId);
      await loadMemberList(orgId);
      setOrgStatus(`已注销 ${email}（数据已转交组长）`);
    } catch (e) {
      setOrgStatus(`注销失败：${e}`);
    }
  };

  // 组长生成/重置邀请码（每个组织一个，显示出来让组长复制转发）。
  const generateInviteCode = async (orgId: string, orgName: string) => {
    if (!base || !token) return;
    try {
      const code = await api.teamGenerateOrgInviteCode(base, token, orgId);
      setInviteCodes((prev) => ({ ...prev, [orgId]: code }));
      // 生成后自动复制到剪贴板，组长直接可用（不用手动选中复制）。
      try {
        await navigator.clipboard.writeText(code);
        setOrgStatus(`已生成「${orgName}」邀请码：${code}（已复制）`);
      } catch {
        setOrgStatus(`已生成「${orgName}」邀请码：${code}`);
      }
    } catch (e) {
      setOrgStatus(`生成邀请码失败：${e}`);
    }
  };

  // 用户凭邀请码加入组织（码即授权，直接入组）。
  const joinByCode = async () => {
    if (!base || !token) { setOrgStatus("请先登录团队账号"); return; }
    const code = joinCode.trim();
    if (!code) { setOrgStatus("请输入邀请码"); return; }
    try {
      await api.teamJoinOrgByCode(base, token, code);
      setJoinCode("");
      setOrgStatus("已加入组织");
      await loadOrgs(base, token);
    } catch (e) {
      setOrgStatus(`加入失败：${e}`);
    }
  };

  // 组长在组织下创建共享空间：调 create_space 带 org_id，组员自动可访问。
  const createOrgSpace = async (orgId: string, orgName: string) => {
    if (!base || !token) return;
    inputDialog({
      title: `在「${orgName}」创建共享空间`,
      placeholder: "空间名称",
      defaultValue: "",
      onSubmit: async (name) => {
        const n = name.trim();
        if (!n) return;
        try {
          const sp = await api.teamCreateSpace(base, token, n, orgId);
          setOrgStatus(`已在「${orgName}」创建共享空间「${sp.name}」`);
        } catch (e) {
          setOrgStatus(`创建共享空间失败：${e}`);
        }
      },
    });
  };

  return (
    <>
      <section className="set-section">
        <div className="set-section-title">当前团队账号</div>
        {authed ? (
          <div className="acct-login-card">
            <span className="set-status-dot set-dot-on" />
            <div className="set-row-text">
              <div className="set-row-name">{email || hostLabel(serverUrl)}</div>
              <div className="set-row-sub">{email ? `${hostLabel(serverUrl)} · 已登录` : `已登录 · ${hostLabel(serverUrl)}`}</div>
            </div>
            <span className="acct-actions">
              <button className="set-btn is-danger" onClick={() => void deactivateSelf()}>注销账号</button>
              <button className="set-btn" onClick={() => void logout()}>登出</button>
            </span>
          </div>
        ) : (
          <div className="acct-login-card">
            <span className="set-status-dot" />
            <div className="set-row-text">
              <div className="set-row-name">未登录团队账号</div>
              <div className="set-row-sub">在侧栏「同步」里登录或注册后，这里会显示当前身份</div>
            </div>
          </div>
        )}
      </section>

      <section className="set-section">
        <div className="set-section-title">
          <span>同步身份（按服务器分组）</span>
          {/* 去同步：关闭设置中心返回主界面（侧栏「同步」面板常驻）。 */}
          <button className="set-btn" style={{ marginLeft: "auto" }} onClick={() => useEditorStore.getState().closeSettings()}>
            去同步
          </button>
        </div>
        {groups.length === 0 ? (
          <p className="set-hint">
            尚无同步身份。在侧栏「同步」里为某个空间配置服务器并登录后，会按服务器在此分组显示。
          </p>
        ) : (
          <div className="set-list">
            {groups.map((g) => (
              <div key={g.server_url} className="set-group">
                <div className="set-group-head">
                  <span className="set-row-name">{hostLabel(g.server_url)}</span>
                  <button className="set-btn" disabled={syncing} onClick={() => void syncGroup(g)}>
                    {syncing ? "同步中…" : "同步该组"}
                  </button>
                </div>
                {g.wss.map((w) => (
                  <div key={w.ws_id} className="set-group-item">
                    <span className="set-group-item-name">
                      {w.name}
                      <span className="set-chip-inline">{w.spaceId ? "空间" : "单用户"}</span>
                    </span>
                    <span className="set-chip-inline on">{w.token ? "已认证" : "未认证"}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {status && <div className="set-status-line">{status}</div>}
      </section>

      <section className="set-section">
        <div className="set-section-title">组织管理</div>
        {!isDesktopPlatform() ? (
          <p className="set-hint">Web 版不支持组织管理，请用桌面版。</p>
        ) : authed ? (
          <>
            <div className="set-row">
              <div className="set-row-text">
                <div className="set-row-name">我的组织</div>
                <div className="set-row-sub">组长可集中管理组内账号与角色</div>
              </div>
              <button className="set-btn" onClick={() => void createOrg()}>新建组织</button>
            </div>
            {/* 凭邀请码加入组织：新用户拿到组长发的码，输入即入组（码即授权）。 */}
            <div className="org-join">
              <input
                className="sync-input"
                placeholder="有邀请码？输入并加入组织"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
              />
              <button className="sync-btn" onClick={() => void joinByCode()}>加入</button>
            </div>
            {orgs.length === 0 ? (
              <div className="org-empty-help">
                <p className="set-hint"><b>你还没加入任何组织。</b>加入方式（任选其一）：</p>
                <ul className="org-empty-list">
                  <li><b>有邀请码</b>：在上方输入组长发的<b>组织邀请码</b>，点「加入」即入组。</li>
                  <li><b>被组长邀请</b>：等组长在成员管理里邀请你，<b>批准后</b>你就成为成员。</li>
                  <li><b>被加为空间成员</b>：组长把你加进某个空间成员，就能<b>绑定空间同步</b>（多设备）。
                    <div className="org-empty-note">提示：加入组织 ≠ 能同步空间——还需组长把你加为<b>空间成员</b>。</div>
                  </li>
                </ul>
                <p className="set-hint">如果你是要<b>新建组织当组长</b>，点右上「新建组织」。</p>
              </div>
            ) : (
              <div className="set-list">
                {orgs.map((o) => {
                  const data = orgMembers[o.id];
                  const members = data?.members ?? [];
                  const pending = data?.pending ?? [];
                  const email = inviteEmail[o.id] ?? "";
                  return (
                    <div key={o.id} className="set-group">
                      <div className="set-group-head">
                        <span className="set-row-name">{o.name}</span>
                        <span className="set-row-sub">
                          {o.role === "admin" ? "组长" : "成员"} · {members.length} 人
                        </span>
                        {o.role === "admin" && (
                          <button className="set-btn" onClick={() => void createOrgSpace(o.id, o.name)}>创建共享空间</button>
                        )}
                      </div>
                      {o.role === "admin" && (
                        <div className="org-invite-code">
                          <span className="set-row-sub">邀请码：{inviteCodes[o.id] || "未生成"}</span>
                          <button className="set-btn" onClick={() => void generateInviteCode(o.id, o.name)}>
                            {inviteCodes[o.id] ? "重新生成" : "生成邀请码"}
                          </button>
                        </div>
                      )}
                      {pending.length > 0 && (
                        <div className="org-members org-pending">
                          <div className="org-pending-title">待加入</div>
                          {pending.map((p) => (
                            <div key={p.email} className="set-group-item">
                              <span className="org-email">{p.email}</span>
                              <span className="set-row-sub">待批准</span>
                              <span className="org-actions">
                                <button className="set-btn" onClick={() => void approveInvite(o.id, p.email)}>批准</button>
                                <button className="set-btn" onClick={() => void rejectInvite(o.id, p.email)}>拒绝</button>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {members.length > 0 ? (
                        <div className="org-members">
                          {members.map((m) => (
                            <div key={m.user_id} className="set-group-item">
                              <span className="org-email">{m.email}</span>
                              <span className="set-row-sub">
                                {m.role === "admin" ? "组长" : "成员"}{m.disabled ? " · 已停用" : ""}
                              </span>
                              <span className="org-actions">
                                {o.role === "admin" && (
                                  <>
                                    <button className="set-btn" onClick={() => void toggleActive(o.id, m)}>
                                      {m.disabled ? "启用" : "停用"}
                                    </button>
                                    <button className="set-btn is-danger" onClick={() => void deactivateMember(o.id, m.user_id, m.email)}>
                                      注销
                                    </button>
                                    <button className="set-btn" onClick={() => void removeMember(o.id, m.user_id)}>移除</button>
                                  </>
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="set-hint">还没有成员。</p>
                      )}
                      {o.role === "admin" && (
                        <div className="org-invite">
                          <input
                            className="sync-input"
                            placeholder="成员邮箱"
                            value={email}
                            onChange={(e) => setInviteEmail((prev) => ({ ...prev, [o.id]: e.target.value }))}
                          />
                          <button className="sync-btn" onClick={() => void inviteMember(o.id)}>邀请</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {orgStatus && <div className="set-status-line">{orgStatus}</div>}
          </>
        ) : (
          <p className="set-hint">未登录团队账号，无法管理组织。在侧栏「同步」里登录。</p>
        )}
      </section>
    </>
  );
}


function AppearancePane() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  const { i18n } = useTranslation();
  const customTitleBar = useWindowChrome((s) => s.custom);
  const setCustomTitleBar = useWindowChrome((s) => s.setCustom);
  const material = useWindowChrome((s) => s.material);
  const setMaterial = useWindowChrome((s) => s.setMaterial);
  const setLang = (lng: string) => {
    try { localStorage.setItem("shuyonote:lang", lng === "system" ? "" : lng); } catch { /* ignore */ }
    void i18n.changeLanguage(lng === "system" ? (navigator.language?.toLowerCase().startsWith("en") ? "en" : "zh-CN") : lng);
  };
  return (
    <>
      <section className="set-section">
        <div className="set-section-title">语言 / Language</div>
        <div className="set-chip-row">
          <button
            className={`set-chip${i18n.language?.startsWith("zh") ? " is-on" : ""}`}
            onClick={() => setLang("zh-CN")}
          >
            中文
          </button>
          <button
            className={`set-chip${i18n.language?.toLowerCase().startsWith("en") ? " is-on" : ""}`}
            onClick={() => setLang("en")}
          >
            English
          </button>
        </div>
        <p className="set-hint">未翻译的界面暂以中文显示。</p>
      </section>
      <section className="set-section">
        <div className="set-section-title">基础主题</div>
        <div className="set-chip-row">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`set-chip${theme === t.id ? " is-on" : ""}`}
              onClick={() => setTheme(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>
      <section className="set-section">
        <div className="set-section-title">强调色</div>
        <div className="set-swatch-row">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              className={`set-swatch${accent === a.id ? " is-on" : ""}`}
              style={{ background: a.light }}
              title={a.name}
              aria-label={a.name}
              onClick={() => setAccent(a.id)}
            />
          ))}
        </div>
        <p className="set-hint">强调色作用于按钮、选中态与链接，随明暗主题自动取对应色值。</p>
      </section>

      {isDesktopPlatform() && (
        <section className="set-section">
          <div className="set-section-title">窗口</div>
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-name">自定义标题栏</div>
              <div className="set-row-sub">
                顶栏显示「当前页面 · 空间」并与应用同色。关掉则用系统标题栏——
                若贴边分屏（Aero Snap）或边缘缩放手感不对，退回系统栏即可。
              </div>
            </div>
            <button
              className={`ui-toggle ${customTitleBar ? "on" : ""}`}
              role="switch"
              aria-checked={customTitleBar}
              onClick={() => setCustomTitleBar(!customTitleBar)}
            >
              <span className="ui-toggle-knob" />
            </button>
          </div>
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-name">材质（Mica）</div>
              <div className="set-row-sub">
                顶栏透出桌面壁纸，Win11 22H2+ 生效，旧系统自动忽略。壁纸较花时
                可能影响观感，需要时可关——与标题栏染色互斥。
              </div>
            </div>
            <button
              className={`ui-toggle ${material ? "on" : ""}`}
              role="switch"
              aria-checked={material}
              onClick={() => setMaterial(!material)}
            >
              <span className="ui-toggle-knob" />
            </button>
          </div>
          <p className="set-hint">两项切换均即时生效，无需重启。</p>
        </section>
      )}
    </>
  );
}

// 插件卡片图标：按 PLUGIN_META 的 icon 键绘制。内联 SVG，不引其它图标组件。
function PluginGlyph({ icon }: { icon: string }) {
  const paths: Record<string, React.ReactNode> = {
    stats: <><path d="M4 20h16" /><path d="M7 20v-6M12 20V9M17 20V13" /></>,
    export: <><path d="M12 15V3" /><path d="M8 7l4-4 4 4" /><path d="M4 17v3h16v-3" /></>,
    database: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /></>,
    template: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>,
    plugin: <><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="13" width="8" height="8" rx="2" /><path d="M7 11v6M11 7h6" /></>,
    ai: <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4.5 1.5c-.8 1-2 1.3-2 2.5M12 17h.01" /></>,
    view: <><circle cx="12" cy="12" r="3" /><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /></>,
    pdf: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6" />
        {/* 「PDF」角标：让它一眼可辨是 PDF 而不是普通文档。chip 底是红色
            （--cat-red），文字用固定白色保证可读。 */}
        <rect x="8" y="13" width="8" height="5" rx="1" fill="currentColor" stroke="none" />
        <text x="12" y="16.6" textAnchor="middle" fontSize="3.4" fontStyle="italic" fontWeight="700" fill="#fff" stroke="none">PDF</text>
      </>
    ),
    sync: <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>,
    report: <><path d="M3 3v18h18" /><rect x="7" y="12" width="3" height="6" /><rect x="12" y="8" width="3" height="10" /></>,
  };
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[icon] ?? paths.view}
    </svg>
  );
}

function PluginsPane() {
  const managerPlugins = usePlugins((s) => s.plugins);
  const setManagerOpen = usePlugins((s) => s.setManagerOpen);
  const toggle = usePlugins((s) => s.toggle);
  const load = usePlugins((s) => s.load);
  const enabled = managerPlugins.filter((p) => p.enabled).length;
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="set-section">
      <div className="set-section-title">
        插件管理
        <span className="plugin-count">{enabled}/{managerPlugins.length} 已启用</span>
      </div>
      {managerPlugins.length === 0 ? (
        <div className="plugin-empty">
          <p>未发现磁盘插件。</p>
          <p className="set-hint">从本地文件夹安装，或把插件放入插件目录。</p>
          <button className="set-btn" onClick={() => setManagerOpen(true)}>打开插件管理</button>
        </div>
      ) : (
        <div className="plugin-grid">
          {managerPlugins.map((p) => (
            <div key={p.id} className={`plugin-card${p.enabled ? "" : " is-off"}`}>
              <div className="plugin-card-head">
                <span className="plugin-icon"><PluginGlyph icon="plugin" /></span>
                {/* 右上角 = 状态兼控制：一个开关，既显示启用/禁用，点击即切换。
                    不再单独保留状态点或底部大开关——一处表达就够了。 */}
                <button
                  className={`ui-toggle${p.enabled ? " on" : ""}`}
                  role="switch"
                  aria-checked={p.enabled}
                  title={p.enabled ? "点击禁用" : "点击启用"}
                  onClick={() => void toggle(p.id)}
                >
                  <span className="ui-toggle-knob" />
                </button>
              </div>
              <div className="plugin-name">{p.name}</div>
              <div className="plugin-sub">
                <span className="plugin-desc">{p.description || "—"}</span>
                <span className="plugin-meta">{p.commands.length} 个命令 · v{p.version}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="set-hint">
        磁盘插件通过受限 JS 运行时（boa）执行；其命令出现在命令面板（Ctrl+K）。
      </p>
    </section>
  );
}

// 端到端加密：口令即密钥，关闭/开启都会触发全库重写，所以这里的破坏性操作
// 一律要二次确认，且把「丢失不可找回」写在入口而不是等出事再说。
function SecurityPane() {
  const [enabled, setEnabled] = useState(false);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const desktop = isDesktopPlatform();

  const refresh = useCallback(() => {
    api
      .encryptionStatus()
      .then((s) => {
        setEnabled(s.enabled);
        setLocked(s.locked);
      })
      .catch(() => {});
  }, []);
  useEffect(() => refresh(), [refresh]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, "success");
      setPass("");
      setPass2("");
      setConfirmOff(false);
      refresh();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const state = !enabled ? "off" : locked ? "locked" : "on";
  const canEnable = pass.trim().length >= 8 && pass === pass2;

  return (
    <section className="set-section">
      <div className="set-section-title">端到端加密</div>
      {!desktop && (
        <div className="set-note">Web 版不支持本地静置加密，请使用桌面版。</div>
      )}

      <div className={`set-status set-status-${state}`}>
        <span className="set-status-dot" />
        <div className="set-status-text">
          <b>
            {state === "off" ? "未开启" : state === "locked" ? "已加密 · 会话已锁定" : "已加密 · 已解锁"}
          </b>
          <span>
            {state === "off"
              ? "笔记以明文存放在本机数据库中。"
              : state === "locked"
                ? "内容不可读，解锁后才会加载；同步在解锁前会被拒绝。"
                : "本机数据库与同步内容均为密文，服务端看不到明文。"}
          </span>
        </div>
      </div>

      {state === "off" && (
        <>
          <div className="set-field">
            <label htmlFor="set-enc-pass">设置口令（至少 8 位）</label>
            <input
              id="set-enc-pass"
              className="set-input"
              type="password"
              autoComplete="new-password"
              placeholder="口令"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              disabled={!desktop}
            />
          </div>
          <div className="set-field">
            <label htmlFor="set-enc-pass2">再输一次</label>
            <input
              id="set-enc-pass2"
              className="set-input"
              type="password"
              autoComplete="new-password"
              placeholder="确认口令"
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canEnable && run(() => api.setEncryption(pass), "已开启端到端加密")}
              disabled={!desktop}
            />
            {pass2 && pass !== pass2 && <p className="set-error">两次输入不一致</p>}
          </div>
          <div className="set-danger-note">
            <b>口令即密钥，丢失无法找回。</b>没有任何后门或找回流程——忘记口令等于永久失去这些笔记，请先妥善保存（并建议先做一次备份导出）。
          </div>
          <div className="set-actions">
            <button
              className="set-btn is-primary"
              disabled={!desktop || busy || !canEnable}
              onClick={() => run(() => api.setEncryption(pass), "已开启端到端加密")}
            >
              开启加密
            </button>
          </div>
        </>
      )}

      {state === "locked" && (
        <>
          <div className="set-field">
            <label htmlFor="set-enc-unlock">输入口令解锁</label>
            <input
              id="set-enc-unlock"
              className="set-input"
              type="password"
              placeholder="口令"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && pass && run(() => api.unlockEncryption(pass), "已解锁")}
            />
          </div>
          <div className="set-actions">
            <button className="set-btn is-primary" disabled={busy || !pass} onClick={() => run(() => api.unlockEncryption(pass), "已解锁")}>
              解锁
            </button>
          </div>
        </>
      )}

      {state === "on" && (
        <div className="set-actions">
          <button className="set-btn" disabled={busy} onClick={() => run(() => api.lockEncryption(), "已锁定（下次同步前需解锁）")}>
            立即锁定
          </button>
        </div>
      )}

      {enabled && (
        <div className="set-danger">
          <div className="set-danger-title">危险操作</div>
          {!confirmOff ? (
            <div className="set-danger-row">
              <div className="set-danger-text">
                关闭加密会把全库解密回明文写盘，过程不可中断。
              </div>
              <button className="set-btn is-danger" disabled={busy} onClick={() => setConfirmOff(true)}>
                关闭加密
              </button>
            </div>
          ) : (
            <div className="set-danger-row">
              <div className="set-danger-text">
                确认关闭？之后本机笔记将以<b>明文</b>存放，同步也不再加密。
              </div>
              <div className="set-danger-btns">
                <button className="set-btn" disabled={busy} onClick={() => setConfirmOff(false)}>
                  取消
                </button>
                <button
                  className="set-btn is-danger"
                  disabled={busy}
                  onClick={() => run(() => api.disableEncryption(), "已关闭端到端加密")}
                >
                  确认关闭
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function AboutPane() {
  const openAbout = useEditorStore((s) => s.openAbout);
  const closeSettings = useEditorStore((s) => s.closeSettings);
  const updateAvailable = useEditorStore((s) => s.updateAvailable);
  const latestVersion = useEditorStore((s) => s.latestVersion);
  return (
    <section className="set-section">
      <div className="set-section-title">版本</div>
      <div className="set-row">
        <div className="set-row-text">
          <div className="set-row-name">ShuyoNote v{APP_VERSION}</div>
          <div className="set-row-sub">
            {updateAvailable && latestVersion ? `发现新版本 v${latestVersion}` : "许可证 " + APP_LICENSE}
          </div>
        </div>
        <button
          className={`set-btn${updateAvailable ? " is-primary" : ""}`}
          onClick={() => {
            closeSettings();
            openAbout();
          }}
        >
          {updateAvailable ? "查看更新" : "关于与更新"}
        </button>
      </div>
      <p className="set-hint">
        「关于」里可检查更新、查看开源与反馈链接，并控制是否允许跳转到外部网站（隐私开关）。
      </p>
    </section>
  );
}

// 独立设置中心：左侧标签栏 + 右侧内容。把原先散落在主题弹层里的
// 外观 / 插件 / 端到端加密，以及 AI 配置统一收口，避免「危险开关藏在
// 调色板里」这种语义错位。
export function SettingsDialog() {
  const { t } = useTranslation();
  const open = useEditorStore((s) => s.settingsOpen);
  const tab = useEditorStore((s) => s.settingsTab);
  const setTab = useEditorStore((s) => s.setSettingsTab);
  const close = useEditorStore((s) => s.closeSettings);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return createPortal(
    <div
      className="set-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="set-dialog" role="dialog" aria-label="设置" aria-modal="true">
        <nav className="set-rail" aria-label="设置分类">
          <div className="set-rail-title">设置</div>
          {TABS.map((it) => (
            <button
              key={it.id}
              className={`set-rail-item${tab === it.id ? " is-on" : ""}`}
              aria-current={tab === it.id}
              onClick={() => setTab(it.id)}
            >
              <span className="set-rail-icon">{it.icon}</span>
              <span className="set-rail-text">
                <span className="set-rail-label">{t(it.labelKey)}</span>
                <span className="set-rail-hint">{t(it.hintKey)}</span>
              </span>
            </button>
          ))}
        </nav>
        <div className="set-body">
          <header className="set-body-head">
            <div className="set-body-head-text">
              <div className="set-body-title">{TABS.find((x) => x.id === tab) ? t(TABS.find((x) => x.id === tab)!.labelKey) : ""}</div>
              <div className="set-body-desc">{TABS.find((x) => x.id === tab) ? t(TABS.find((x) => x.id === tab)!.hintKey) : ""}</div>
            </div>
            <button className="set-close" onClick={close} aria-label="关闭设置">×</button>
          </header>
          <div className="set-body-scroll">
            <div className="set-body-inner">
            {tab === "appearance" && <AppearancePane />}
            {tab === "spaces" && <SpacesPane />}
            {tab === "account" && <AccountPane />}
            {tab === "data" && <DataPane />}
            {tab === "plugins" && <PluginsPane />}
            {tab === "security" && <SecurityPane />}
            {tab === "ai" && (
              <section className="set-section set-ai">
                <div className="set-section-title">AI 服务</div>
                <AiSettingsForm onDone={() => {}} showCancel={false} />
              </section>
            )}
            {tab === "about" && <AboutPane />}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
