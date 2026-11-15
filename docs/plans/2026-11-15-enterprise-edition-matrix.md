# 企业版版本矩阵 —— 标准版 / 增强版 / 行业版（v1 已拍板）

状态：**已拍板（owner 2026-11-15）· 标准版 SKU 标题/professional 已实现（0.4.30）；iroh/行业版/服务端部署待做**
证据：`../../../shuyonote-enterprise-client/docs/decisions/2026-11-15-enterprise-sku-matrix.md`

本文只定义三个对外 SKU 的边界、Edition 映射、iroh、白标、identifier、更新通道与升级路径；功能需求仍以企业仓规格为准，本文不复制功能清单。

> ⚠️ 本文件是**产品侧镜像**；四问的权威记录在企业仓决策文件。两边冲突时以企业仓决策为准。

---

## 1. 先拆层：SKU、Edition、iroh、白标不是一回事

| 层 | 取值 | 决定什么 |
|---|---|---|
| **SKU** | `standard` / `enhanced` / `industry` | 对外商品名、安装包、更新通道 |
| **Edition** | `standard` / `professional` / `industry` | entitlement 能力基线 |
| **iroh** | `false` / `true` | 构建变体；不是 Edition |
| **白标** | `none` / add-on | 独立授权；不是 Edition |
| **identifier** | 见下表 | 是否同机共存、能否原地升级 |

⛔ 不再把 `enterprise-standard` 这类值写进 `edition` 字段。

---

## 2. 三个 SKU

| SKU | 对外标题 | edition | iroh | 白标 | identifier | 更新通道 |
|---|---|---|---|---|---|---|
| 标准版 `standard` | **ShuyoNote企业标准版** | `professional` | 否 | 不含 | `cn.shuyo.enterprise.standard` | `enterprise-stable` |
| 增强版 `enhanced` | **ShuyoNote企业增强版** | `professional` | 是 | 不含 | `cn.shuyo.enterprise.standard` | `enterprise-enhanced` |
| 行业版 `industry` | **ShuyoNote企业行业版** | `industry` | 可选 | 仅按 add-on | `cn.shuyo.enterprise.industry`（同机共存时） | `enterprise-industry` |

补充：

- **Lite** 是 2–10 人自助交付档，不在三个 SKU 内；它使用 `edition=standard`。
- 标准版使用 `professional` entitlement 的原因：11–300 人需要组织 RBAC、会议、包导入导出；`standard` 基线不够。
- 标题按 `SKU` 派生，⛔ 不按 `edition` 派生；否则标准版会变成“增强版”。

---

## 3. iroh

```text
标准版：iroh=false
增强版：iroh=true
行业版：按项目配置
```

- iroh 是构建/能力开关，不是第四个 Edition。
- 当前企业客户端 Cargo 无条件依赖 iroh；在加 feature gate 之前，**“标准版产物不含 iroh 符号”这条判据不成立**。
- 必须先实现编译期 feature gate，才能把“标准版不含 iroh”写成验收通过。

---

## 4. 白标

```text
标准版：不含白标
增强版：不含白标
行业版：白标按独立 add-on 授权
OEM：单独授权，与 Edition 正交
```

客户白标（例如“山西焦煤电子招采平台统一客户端”）使用独立 identifier 与客户品牌配置；⛔ 不改变 SKU、Edition、identifier 规则或更新通道。

---

## 5. identifier 与升级

| 路径 | 做法 | 数据 |
|---|---|---|
| 标准版 → 增强版 | 同 identifier，换包（仅 iroh 构建差异） | 不变，不迁移 |
| 标准版/增强版 → 行业版 | 行业版独立 identifier 时，需显式数据迁移 | 迁移 |
| 任意 → 降级 | 不做降级，只允许导出 | — |

- 标准版/增强版必须共用 identifier，才能原地升级。
- 标准版/增强版**不能同机共存**；更新通道分开，防止装错包。
- 行业版是否与标准版同机共存，当前未做；若做，使用独立 identifier + 数据迁移。

---

## 6. 配置形状

```jsonc
{
  "sku": "standard",
  "edition": "professional",
  "features": { "iroh": false },
  "identifier": "cn.shuyo.enterprise.standard",
  "updateChannel": "enterprise-stable",
  "branding": {
    "brand": "ShuyoNote",
    "product_name": "ShuyoNote企业",
    "title_mode": "edition",
    "website": "https://shuyo.cn",
    "logo": "branding/logo.svg"
  }
}
```

增强版只改：

```jsonc
{
  "sku": "enhanced",
  "features": { "iroh": true },
  "updateChannel": "enterprise-enhanced"
}
```

- `edition` 只允许 `standard/professional/industry`。
- `branding.logo` 必须是真实文件，不能写目录。
- `sku` 字段尚未进 tenant schema 与标题 resolver；这是实现待办，不是可选项。
- 当前标准版 0.4.29 仍是 `edition=standard`；按本矩阵必须改为 `professional`，并回归 entitlement。

---

## 7. 验收判据

```text
1. 三个 SKU 标题分别为 ShuyoNote企业标准版/增强版/行业版
2. edition 取值只能是 standard/professional/industry
3. 标准版 edition=professional；Lite edition=standard
4. 标准版/增强版 identifier 相同，更新通道不同
5. 标准版不含 iroh（feature gate 后符号扫描为空）
6. 增强版 iroh=true 且跨网用例通过
7. 行业版 profile 能装配行业角色；标准版 domain_packs=[]
8. 标准版不含白标；客户白标独立配置
9. branding 由同一份 resolver 派生；三版标题/Logo/官网正确
```

---

## 8. 仍未完成（实现，不是拍板）

```text
已完成（0.4.30）：
1. tenant schema 增加 sku
2. 标题 resolver 按 sku 派生
3. 标准版配置改为 sku=standard / edition=professional

待做：
4. 服务端标准版 SHUYO_EDITION 同步 professional，并回归 entitlement
5. iroh 编译 feature gate
6. 增强版/行业版 overlay 与更新通道目录
7. 标准版/增强版同 identifier 的安装/升级实测
```

## 9. 引用

- 四问权威决策：`../../../shuyonote-enterprise-client/docs/decisions/2026-11-15-enterprise-sku-matrix.md`
- 规模分档：`../../../shuyonote-enterprise-client/docs/specs/2026-11-07-scale-tiers-and-delivery-forms-spec.md`
- 白标授权：`../../../shuyonote-enterprise-client/docs/decisions/2026-10-28-white-label-edition-entitlement.md`
- 品牌标题：`../../../shuyonote-enterprise-client/docs/decisions/2026-11-15-product-branding-and-setup-title.md`
- iroh 五层控制：`../../../shuyonote-enterprise-client/docs/specs/2026-10-16-enterprise-edition-workbench-requirements.md`（FR-IROH-04）
