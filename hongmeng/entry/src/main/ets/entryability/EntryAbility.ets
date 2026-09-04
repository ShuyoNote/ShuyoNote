import { hilog } from "@kit.PerformanceAnalysisKit";
import { AbilityConstant, UIAbility, Want } from "@kit.AbilityKit";
import { window } from "@kit.ArkUI";

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    // App 启动：可在此做本地化初始（会话/数据目录）。
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent("pages/Index", (err) => {
      if (err && err.code) {
        hilog.error(0x0000, "ShuyoNote", "loadContent failed: %{public}s", JSON.stringify(err));
      }
    });
  }
}
