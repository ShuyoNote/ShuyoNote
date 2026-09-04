// 鸿蒙 ArkTS 同步客户端骨架（对齐 src-tauri/src/sync.rs 协议）。
// HTTP 用 @kit.NetworkKit；本地 changes 表/进度由鸿蒙数据层提供（见文档说明）。
import { http } from '@kit.NetworkKit';

export interface ChangeIn {
  device_seq: number;
  entity: string;
  entity_id: string;
  op: 'upsert' | 'delete';
  payload: string;
}
export interface PushBody {
  device_id: string;
  space_id: string;
  changes: ChangeIn[];
}
export interface AuthResp {
  token: string;
  user?: { id?: string };
  expires_at?: number;
}
export interface SpaceInfo {
  id: string;
  name: string;
  org_id?: string | null;
}

const REQ_TIMEOUT = 20000;

async function baseUrl(server: string): Promise<string> {
  return server.trim().replace(/\/+$/, '');
}

export class SyncClient {
  private token: string = '';
  private deviceId: string = '';

  setToken(t: string): void { this.token = t; }
  setDeviceId(d: string): void { this.deviceId = d; }

  // ---- auth ----
  async register(server: string, email: string, password: string, display?: string, code?: string): Promise<AuthResp> {
    const url = `${await baseUrl(server)}/auth/register`;
    return await this.postJson(url, { email, password, display, register_code: code });
  }
  async login(server: string, email: string, password: string): Promise<AuthResp> {
    const url = `${await baseUrl(server)}/auth/login`;
    return await this.postJson(url, { email, password });
  }
  async me(server: string): Promise<Record<string, unknown>> {
    return await this.getJson(`${await baseUrl(server)}/auth/me`);
  }
  async logout(server: string): Promise<void> {
    await this.postJson(`${await baseUrl(server)}/auth/logout`, {});
  }

  // ---- spaces ----
  async listSpaces(server: string): Promise<SpaceInfo[]> {
    return await this.getJson(`${await baseUrl(server)}/spaces`);
  }
  async createSpace(server: string, name: string, orgId?: string): Promise<SpaceInfo> {
    return await this.postJson(`${await baseUrl(server)}/spaces`, { name, org_id: orgId });
  }

  // ---- push ----
  async push(server: string, spaceId: string, changes: ChangeIn[]): Promise<void> {
    const body: PushBody = { device_id: this.deviceId, space_id: spaceId, changes };
    await this.postJson(`${await baseUrl(server)}/push`, body);
  }

  // ---- pull ----
  async pull(server: string, spaceId: string, since: number): Promise<ChangeIn[]> {
    const url = `${await baseUrl(server)}/pull?since=${since}&limit=500&space_id=${spaceId}&exclude_device=${this.deviceId}`;
    return await this.getJson(url);
  }

  private async postJson(url: string, body: Record<string, unknown>): Promise<any> {
    const h = http.createHttp();
    try {
      const resp = await h.request(url, {
        method: http.RequestMethod.POST,
        header: this.headers(true),
        extraData: JSON.stringify(body),
        expectDataType: http.HttpDataType.STRING,
      });
      return this.parse(resp);
    } finally { h.destroy(); }
  }
  private async getJson(url: string): Promise<any> {
    const h = http.createHttp();
    try {
      const resp = await h.request(url, {
        method: http.RequestMethod.GET,
        header: this.headers(false),
        expectDataType: http.HttpDataType.STRING,
      });
      return this.parse(resp);
    } finally { h.destroy(); }
  }
  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }
  private parse(resp: http.HttpResponse): any {
    if (resp.responseCode === 401) throw new Error('会话已失效，请重新登录');
    if (resp.responseCode !== 200 && resp.responseCode !== 201) {
      throw new Error(`HTTP ${resp.responseCode}`);
    }
    const s = resp.result as string;
    return s ? JSON.parse(s) : null;
  }
}
