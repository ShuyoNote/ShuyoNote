//! 同步载荷里的 **CRDT 状态字段**（桌面侧）—— 与前端 `src/lib/crdt/wireState.ts` **成对**
//! （一套语义、两侧各一份判据；改一边必须同时看另一边）。
//!
//! ## 它解决的是哪个缺口（冲刺 §11.4）
//! 第 41 轮勘察发现：**桌面收下带 `crdt_state` 的页载荷时，那个字段被静默丢掉** ——
//! `PageDetail` 没有 `deny_unknown_fields`（`models.rs`），serde 直接忽略未知字段
//! ⇒ 桌面 pull 只走块级 LWW，本地 CRDT 状态**永远追不上对端**；而编辑器 hydration 以本地状态
//! 为准 ⇒ 桌面上的跨设备编辑会被自己的旧状态**静默覆盖**。
//!
//! ## 这一层只做"读出来"，不做"合并"
//! Rust 侧**没有** Yjs 实现（要不要引进 `yrs` 是 S5 阶段 2 的决策；尖刺已证格式层可行）。
//! 所以这里只把字节**收进旁路表**（`page_crdt_pending`），由**有编辑器语义的那一侧**（WebView 里的
//! TS，`mergeRemotePageState`）在**打开页面时**合并 —— 不在这里长第二份派生实现。
//!
//! ## 三条口径（与 `wireState.ts` 逐条对齐）
//!   ① **没有这一项** ⇒ `None`（老载荷 / 这一页还没有 CRDT 状态）⇒ 走今天那条路（如实降级）；
//!   ② **版本不认识** ⇒ `Unknown(v)` ⇒ **不猜**（猜错＝静默丢块），调用方**留痕**；
//!   ③ **载荷坏了**（`state` 不是数组 / 字节越界）⇒ `Err`（**如实报**，不静默截断、不当空状态）。
use serde_json::Value;

/// 载荷里那一项的名字（只在这里写一次字面量，与 `wireState.ts::CRDT_WIRE_FIELD` 同一个字面量）。
pub const CRDT_WIRE_FIELD: &str = "crdt_state";

/// 版本标记（与 `src/lib/crdt/wireConstants.ts::CRDT_WIRE_VERSION` 同一个数字）。
/// ⚠️ 两侧必须一起改：改一边等于让"旧版本"变成"不认识"，而那条路会**留痕但不合并**。
pub const CRDT_WIRE_VERSION: i64 = 1;

/// 一次"读出来"的结果：四种情形**分得开**（"没有"与"不认识"混成一种就会静默丢块）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireState {
    /// 载荷里没有这一项 ⇒ 走今天那条路。
    None,
    /// 解出来了（不透明字节）。
    Ok(Vec<u8>),
    /// 有这一项但版本不认识 ⇒ **不猜**，调用方留痕。
    UnknownVersion(i64),
}

/// 从**解密后的载荷文本**里读 CRDT 状态。
///
/// `Err` 只用于"载荷坏了"：那是**如实报**（与"没有"/"不认识"分开）。
pub fn extract_wire_state(payload_json: &str) -> Result<WireState, String> {
    let v: Value = match serde_json::from_str(payload_json) {
        Ok(v) => v,
        // 载荷不是 JSON：**不是本函数的事**（调用方本来也会因为解析不出 PageDetail 而跳过），
        // 这里如实回"没有这一项"，不制造第二种失败。
        Err(_) => return Ok(WireState::None),
    };
    let Some(raw) = v.get(CRDT_WIRE_FIELD) else {
        return Ok(WireState::None);
    };
    if raw.is_null() {
        return Ok(WireState::None);
    }
    let Some(obj) = raw.as_object() else {
        return Ok(WireState::None); // 形状不是对象 ⇒ 当"没有"（与 TS 侧的 `typeof raw !== "object"` 同一口径）
    };
    let version = obj.get("v").and_then(Value::as_i64).unwrap_or(i64::MIN);
    if version != CRDT_WIRE_VERSION {
        return Ok(WireState::UnknownVersion(version));
    }
    let Some(arr) = obj.get("state").and_then(Value::as_array) else {
        return Err("crdt_wire: 版本是已知的，但 `state` 不是数组 —— 载荷坏了，如实报错（不静默当成空）".to_string());
    };
    let mut out = Vec::with_capacity(arr.len());
    for (i, b) in arr.iter().enumerate() {
        let n = b.as_i64().ok_or_else(|| format!("crdt_wire: 第 {i} 个字节不是整数"))?;
        if !(0..=255).contains(&n) {
            return Err(format!("crdt_wire: 第 {i} 个字节不是 0..255（如实报错，不静默截断）"));
        }
        out.push(n as u8);
    }
    Ok(WireState::Ok(out))
}

/// 把状态挂到载荷上（**推**那一侧，与 TS 的 `withCrdtWire` 同一形状）。
///
/// ⚠️ **没有状态就不该调它**（调用方判空）—— 这里也照 TS 的口径：空状态 ⇒ 原样返回。
/// ⚠️ 与 TS 的两点如实分化（TS 拿到的是**内存对象**，这里拿到的是**文本**）：
///    · JSON 合法但不是对象（数组/null/字符串）⇒ **原样返回**（与 TS 同一口径：不包一层改掉别人的字节）；
///    · 文本**根本不是 JSON** ⇒ **报错**（响亮）—— TS 侧不存在这一格。
/// ⚠️ 另一点如实写：`serde_json` 默认的 `Map` 是 **BTreeMap**（键有序），所以"加了状态"之后
///    重新序列化出来的**键序与原来不同**（内容不变）。没有状态的路径**不经过这里** ⇒ 老载荷**逐字不变**。
pub fn with_wire_state(payload_json: &str, state: &[u8]) -> Result<String, String> {
    if state.is_empty() {
        return Ok(payload_json.to_string());
    }
    let mut v: Value = serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
    let Some(obj) = v.as_object_mut() else {
        // 载荷不是普通对象：形态是别人定的，包一层会改掉它的字节 ⇒ 原样返回（与 TS 同一口径）。
        return Ok(payload_json.to_string());
    };
    obj.insert(
        CRDT_WIRE_FIELD.to_string(),
        serde_json::json!({ "v": CRDT_WIRE_VERSION, "state": state }),
    );
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 `wireState.test.ts` ⑥/⑦ 成对：有状态 ⇒ 挂上去；**空状态/JSON 非对象 ⇒ 原样**。
    /// ⚠️ "载荷**根本不是 JSON**" 在 TS 侧不存在（那边拿到的是内存里的对象），Rust 侧拿到的是**文本**
    /// ⇒ 这一格如实分化：**报错**（响亮），不猜着把它当对象塞字段。
    #[test]
    fn with_wire_state_attaches_and_is_inert_when_empty() {
        assert_eq!(with_wire_state(r#"{"id":"p1"}"#, &[]).unwrap(), r#"{"id":"p1"}"#);
        assert!(with_wire_state("not json", &[1]).is_err(), "不是 JSON ⇒ 如实报错，不猜");
        assert_eq!(with_wire_state("[1,2]", &[1]).unwrap(), "[1,2]");

        let out = with_wire_state(r#"{"id":"p1","title":"t"}"#, &[0, 255]).unwrap();
        let back: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(back["id"], "p1");
        assert_eq!(back["title"], "t");
        assert_eq!(back["crdt_state"]["v"], CRDT_WIRE_VERSION);
        assert_eq!(back["crdt_state"]["state"], serde_json::json!([0, 255]));
        // 挂上去的能被自己读回来（同一张表，两个方向）
        assert_eq!(extract_wire_state(&out).unwrap(), WireState::Ok(vec![0, 255]));
    }

    /// 与 `wireState.test.ts` ① 成对：往返逐字节相同（含非 UTF-8 字节）。
    #[test]
    fn extract_round_trips_non_utf8_bytes() {
        let bytes: Vec<u8> = vec![0x00, 0xff, 0x80, 0x7f, 0x01];
        let payload = serde_json::json!({ "id": "p1", "crdt_state": { "v": 1, "state": bytes } }).to_string();
        assert_eq!(extract_wire_state(&payload).unwrap(), WireState::Ok(bytes));
    }

    /// 与 `wireState.test.ts` ③ 成对：**缺字段 ≠ 空状态**（老载荷 ⇒ 走今天那条路）。
    #[test]
    fn missing_field_is_none_not_an_empty_state() {
        assert_eq!(extract_wire_state(r#"{"id":"p1"}"#).unwrap(), WireState::None);
        assert_eq!(extract_wire_state(r#"{"id":"p1","crdt_state":null}"#).unwrap(), WireState::None);
        // 形状不是对象：当"没有"（TS 侧同一口径），**不是**"坏载荷"
        assert_eq!(extract_wire_state(r#"{"crdt_state":"x"}"#).unwrap(), WireState::None);
        // 载荷根本不是 JSON：也不是本函数的事（调用方本来就会跳过这一条）
        assert_eq!(extract_wire_state("not json").unwrap(), WireState::None);
    }

    /// 与 `wireState.test.ts` ④ 成对：**版本不认识 ⇒ 不猜**（如实回 `UnknownVersion`）。
    #[test]
    fn unknown_version_is_reported_not_guessed() {
        let payload = r#"{"crdt_state":{"v":99,"state":[1,2,3]}}"#;
        assert_eq!(extract_wire_state(payload).unwrap(), WireState::UnknownVersion(99));
        // 连 `v` 都没有 ⇒ 也是"不认识"（不是"没有"）：**不猜**
        assert_eq!(extract_wire_state(r#"{"crdt_state":{"state":[1]}}"#).unwrap(), WireState::UnknownVersion(i64::MIN));
    }

    /// 与 `wireState.test.ts` ⑤ 成对：载荷坏了 ⇒ **如实抛**，不静默截断。
    #[test]
    fn malformed_state_is_an_error() {
        assert!(extract_wire_state(r#"{"crdt_state":{"v":1,"state":"nope"}}"#).is_err());
        assert!(extract_wire_state(r#"{"crdt_state":{"v":1,"state":[1,300]}}"#).is_err());
        assert!(extract_wire_state(r#"{"crdt_state":{"v":1,"state":[1,-1]}}"#).is_err());
        assert!(extract_wire_state(r#"{"crdt_state":{"v":1,"state":[1,1.5]}}"#).is_err());
    }
}
