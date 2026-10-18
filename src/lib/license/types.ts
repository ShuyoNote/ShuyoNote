// 卡里那层的**载荷形状**（与 Rust `relay_license::LicenseClaims` 同字段名）。
//
// ⚠️ 为什么 TS 侧还要有一份：界面要拿它算"还剩几天 / 哪一态 / 挑哪一代"，
//    而 ⛔ 不联网、⛔ 不验签（验签在 Rust，与中继共用同一份实现 —— 那一侧的口径）。
//    两份只在**字段名**上对齐；⛔ 不许在这里再写一遍签名/序列化逻辑（那是第二份真相）✗。
export interface LicenseClaims {
  /** 格式版本（当前 1） */
  v: number;
  /** card / bundle / trial */
  typ: "card" | "bundle" | "trial";
  /** 订阅主体的**单向散列**（⛔ 不是邮箱明文） */
  sub: string;
  /** 允许的设备散列列表（长度 ≤ seats） */
  dev: string[];
  /** 设备位数 */
  seats: number;
  /** 生效时刻（Unix 秒） */
  nbf: number;
  /** 失效时刻（Unix 秒） */
  exp: number;
  /** 宽限天数 */
  grace: number;
  /** 签名密钥号 */
  kid: string;
  /** 签发时刻（Unix 秒） */
  iat: number;
  /** 唯一编号（⛔ 不复用） */
  jti: string;
  /** 能力位（当前只有 `crossnet`；**空 = 停卡**） */
  cap: string[];
  /** 轮换代数（从 0 起） */
  rot: number;
  /** 前一代 `jti` 的散列（首张可缺） */
  prev?: string;
}
