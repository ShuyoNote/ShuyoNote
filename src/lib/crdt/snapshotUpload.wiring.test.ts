// 判据：**加密快照上传**这条通道的三条安全性质（都属"不炸不报错、只是悄悄泄一份数据"那类）。
//
// 来由：CRDT 阶段 2 的客户端「上传」切片（2026-10-23）。服务端只存不解析
//（`PUT /spaces/{id}/snapshot?snapshotSeq=`），所以"服务端解不开"**完全**依赖两件事：
//   ① 快照源在磁盘上就已经是密文（明文库 ⇒ 拒绝上传，否则就是把明文长期放在云上）；
//   ② Web 平台**不许**走这条路（它没有空间钥匙、库也不是密文 ⇒ 传上去必然是明文）。
// 两条都不会抛异常、也不会让别的测试变红 —— 只能靠源码级判据钉住。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(repo, p), "utf8");

describe("CRDT 加密快照 · 上传通道的安全性质", () => {
  it("① 桌面侧明文库必须被拒（判据在 Rust，消息里要说清为什么）", () => {
    const rs = read("src-tauri/src/space_snapshot_client.rs");
    expect(rs, "缺 ensure_encrypted_source").toMatch(/fn ensure_encrypted_source/);
    expect(rs, "必须先判密文再读字节").toMatch(/space_db_is_encrypted/);
    expect(rs, "拒绝理由要写清（用户看得懂）").toMatch(/还没加密/);
  });

  it("② 快照必须带 snapshotSeq（服务端缺它就 400）", () => {
    const rs = read("src-tauri/src/space_snapshot_client.rs");
    expect(rs).toMatch(/snapshot\?snapshotSeq=/);
  });

  it("③ Web 平台必须**明确拒绝**，而不是传一份明文上去", () => {
    const web = read("src/lib/platform/web.ts");
    expect(web, "web 平台没有这个命令的分支").toMatch(/cmd === "sync_upload_snapshot"/);
    expect(web, "拒绝理由必须点出'明文落云'这条后果").toMatch(/明文落云|不是密文/);
    // ⛔ 反向判据：分支里不许出现"上传"动作（fetch/invoke）
    const branch = web.slice(web.indexOf('cmd === "sync_upload_snapshot"'));
    const body = branch.slice(0, branch.indexOf("throw new Error"));
    expect(body, "web 分支里不许出现网络调用").not.toMatch(/fetch\(|syncFetch\(/);
  });

  it("④ 平台契约里登记了这条命令（否则前端 invoke 会抛未实现）", () => {
    const cmds = read("src/lib/platform/commands.ts");
    expect(cmds).toMatch(/sync_upload_snapshot:\s*\{ args:/);
  });
});
