// 口令锁状态的 React 侧订阅。挂在 `App` 上：挂载时问一次内核，之后跟着 publish 走。
import { useEffect, useState } from "react";
import { refreshVault, subscribeVault, vaultState, type VaultState } from "../lib/vault";

export function useVault(): VaultState {
  const [state, setState] = useState<VaultState>(vaultState);
  useEffect(() => {
    const off = subscribeVault(setState);
    void refreshVault();
    return off;
  }, []);
  return state;
}
