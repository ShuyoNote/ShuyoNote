# 企业版版本矩阵 —— 标准版 / 增强版 / 行业版（草案 · 待评审）

状态：**草案（待评审）·未开工** —— 本文只定义对外三个 SKU 的边界、包差异、更新通道与升级路径；功能需求仍以企业仓规格为准，本文不复制功能清单。

上位：企业仓《规模分档与交付形态规格（Lite / Standard / Enterprise）v0.2》（2026-11-07）已定三档交付形态；《iroh 集成提案》（2026-10-16）只给了"打包变体"一句；《2026-11-14 角色—能力分层》已拍板标准版通用、行业包只进行业租户。三份文档之间缺一份**版本矩阵**，于是包命名、identifier、更新通道、entitlement 各自漂移。本文就是那份矩阵。

---

## 1. 结论先行：3 个对外 SKU（底座仍是一套内核）

| SKU | 对应交付档 | entitlement | 含 iroh（跨网直连） | 行业包 | 更新通道 | identifier 后缀 |
|---|---|---|---|---|---|---|
| **企业标准版** | Standard（11–300 人，T1） | `professional` | 否（编译期不启用） | `domain_packs: []` | `enterprise/standard` | `.enterprise.standard` |
| **企业增强版** | Standard 的跨网变体 | `professional` + iroh | 是（打包层含 iroh） | `domain_packs: []` | `enterprise/enhanced` | `.enterprise.enhanced` |
| **企业行业版** | Enterprise（300+ / 多集团，T2/T4） | `industry` + 增购 | 可选（建议默认含） | 按客户立项的行业包 | `enterprise/industry` | `.enterprise.industry` |

补充两条边界：

- **Lite（2–10 人，T0 单机一体化）不在本文三个 SKU 内**：它是自助下载的小团队档，不涉及白标、多租户、行业包；`Lite → 标准版` 的迁移判据已在企业仓规格里（数据导出/导入演练）。
- **客户名/白标（如"山西焦煤电子招采平台统一客户端"）不是版本**：它是租户 profile 与品牌配置，不得改变 SKU、entitlement、更新通道。

---

## 2. 每个 SKU 的边界

### 2.1 企业标准版

- 目标：11–300 人的单一组织私有化部署（一客户一部署一租户）。
- 包含：核心协作（空间/文档/讨论/页面讨论）、审计与多角色、白标展示、profile 装配（角色→能力→侧边栏/工作台）。
- 不包含：iroh 跨网直连（编译期不启用）、行业角色/行业包、多租户/HA/等保密评。
- 判定口径：`domain_packs == []`；产物里**不出现** iroh 符号与动态库。

### 2.2 企业增强版

- 定义：**标准版 + iroh 跨网直连能力包**，不是"更多功能"的泛指。
- 目标：同一客户在多分支/弱网/跨网段场景下仍需直连协作。
- 打包：同一个内核，仅构建配置打开 iroh；五层控制（编译时、打包时、组织级、空间级、设备级）中**前两层由构建配置保证**，后三层由 profile 与运行时数据控制。
- 不包含：多租户、HA、行业包（这些仍属行业版）。

### 2.3 企业行业版

- 定义：**Enterprise 交付档 + `industry` entitlement + 行业包（domain_packs）**。
- 行业角色（如招采的投标人/评标专家/代理项目经理）只存在于该行业租户的 profile 里，**不进核心角色表**；标准版与增强版一律不加载行业包。
- 行业包必须有独立 id、版本号与验收判据；行业包清单不写进本文（按客户立项，避免把某客户需求当成产品通用需求）。
- 跨网直连可选；多租户/HA/等保密评按项目交付。

---

## 3. 同一内核红线（不可分叉）

1. 一套代码、一个内核：三个 SKU 的差异**只允许**落在承担编译期开关、租户/行业配置、entitlement、打包与签名、品牌配置这五类位置。
2. 禁止：为任一 SKU 复制整份代码、复制前端分支、在组件里写 `if (edition === …)` 散落判断。
3. 能力装配走同一条链：capability → 角色 → 侧边栏/工作台（企业仓已拍板的装配契约），SKU 只改"配置输入"，不改装配代码。

---

## 4. 构建与产物矩阵

每个 SKU 由一份版本配置驱动（建议字段）：

```jsonc
{
  "edition": "enterprise-standard",
  "productName": "ShuyoNote企业版·标准版",
  "identifier": "cn.shuyo.shuyonote.enterprise.standard",
  "updateChannel": "enterprise/standard",
  "features": { "iroh": false },
  "domainPacks": [],
  "branding": { "website": "https://shuyo.cn", "logo": "brand/" }
}
```

产物侧硬要求：

- **identifier 三版互不相同**（相同会导致两个 SKU 互相覆盖安装）。
- **更新通道互不相同**（共用会导致企业版被个人版或别的 SKU 顶掉）。
- 安装包文件名必须含 edition，例如 `ShuyoNote_2.1.15_enterprise-standard_x64-setup.exe`。
- 三个 SKU 使用**同一个版本号**；版本门禁需同时核对三份配置。

---

## 5. 升级路径

| 路径 | 做法 | 数据 | 判据 |
|---|---|---|---|
| Lite → 标准版 | 导出/导入演练 | 迁移后可用 | 企业仓 LIT-018/LIT-019 |
| 标准版 → 增强版 | 同版本换包（iroh 仅构建差异） | 不变 | 换包后空间/文档/审计读数一致 |
| 标准版/增强版 → 行业版 | 换租户 profile + 引入行业包 | 不变 | 行业角色出现、标准版仍 `domain_packs: []` |
| 任意 → 降级 | 不做降级，只允许导出 | — | 文档与支持话术统一 |

---

## 6. 验收判据（可机器核）

- 三 SKU 同版本号；产物文件名含 edition。
- identifier、updateChannel 三版互不相同。
- 标准版产物不含 iroh（符号/动态库扫描为空）。
- 增强版产物含 iroh 且跨网用例通过。
- 行业版 profile 能装配出行业角色；标准版 `domain_packs == []`。
- 品牌字段（标题/图标/官网）由同一份 branding 配置派生，三版各自正确。

---

## 7. 待拍板（需 owner 决定）

1. 增强版是**独立 SKU**（独立定价/许可），还是标准版的**可选增购**？
2. 行业版对外命名：叫"企业行业版"，还是"企业版 · 行业版"？
3. 行业包随主安装包分发（体积换简单），还是按需安装（体积换安装步骤）？
4. Lite 是否纳入这套矩阵（当前不在，保持"小团队自助档"独立）？

---

## 8. 引用与边界

- 交付分档依据：`shuyonote-enterprise-client/docs/specs/2026-11-07-scale-tiers-and-delivery-forms-spec.md`（第 24–28 行）。
- 打包变体依据：`shuyonote-enterprise-client/docs/sources/2026-10-16-enterprise-iroh-integration-proposal.md`（第 116 行）；五层控制见同一仓 `docs/specs/2026-10-16-enterprise-edition-workbench-requirements.md`（FR-IROH-04）。
- 标准版通用与行业包边界：`shuyonote-enterprise-client/docs/decisions/2026-11-14-role-capability-layering.md`（结论 ①/⑤）。
- 企业仓在本会话**只读**：本文是产品仓侧的矩阵草案，供企业侧评审；不修改企业仓任何文件，也不复制其功能清单。
- 本文不替代功能需求：每个 SKU 的能力细节以企业仓对应 spec 为准；本文只回答"有哪几个版本、怎么分、怎么升级、怎么判"。
