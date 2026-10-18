// `joinRefusals` 的判据（2026-10-18）：两条通道的拒绝理由合并时，**共用的开头只说一次**。
//
// 由来：设置页「全库索引」那一块把两条理由并排显示，两条都以同一句「按红线…」开头
// ⇒ 现场读成"复读机"，用户以为出了两次错。这里钉住"去重开头、保留两条尾巴"。

import { describe, expect, it } from "vitest";
import { joinRefusals } from "./localRefusal";

const PREFIX = "按红线，抽取不得使用远程 provider（你配的是 https://api.deepseek.com）。";
const VISION = `${PREFIX}请把模型跑在本机（例如 http://127.0.0.1:11434），抽取才会启用；在此之前，图片/扫描件这类需要视觉的抽取器会返回 provider_error。`;
const ASR = `${PREFIX}语音转写同样要求模型跑在本机（例如 http://127.0.0.1:8080/v1）；在此之前，音视频这类需要转写的抽取器会返回 provider_error。`;

describe("joinRefusals：合并两条拒绝理由", () => {
  it("两条共用开头 ⇒ 开头只出现一次，两条尾巴都在", () => {
    const s = joinRefusals([VISION, ASR]);
    expect(s).not.toBeNull();
    const text = s!;
    expect(text.split(PREFIX).length - 1, "开头那句只该出现一次").toBe(1);
    expect(text).toContain("图片/扫描件");
    expect(text).toContain("音视频");
  });

  it("只有一条 ⇒ 原样返回", () => {
    expect(joinRefusals([VISION])).toBe(VISION);
    expect(joinRefusals([undefined, ASR])).toBe(ASR);
  });

  it("没有 ⇒ null（调用方据此不显示那一块）", () => {
    expect(joinRefusals([])).toBeNull();
    expect(joinRefusals([undefined, null, ""])).toBeNull();
  });

  it("开头不共用 ⇒ 两条都完整保留（⛔ 不误删）", () => {
    const other = "另一个原因：本机端点不可达。";
    const text = joinRefusals([VISION, other])!;
    expect(text).toContain("本机端点不可达");
    expect(text).toContain("图片/扫描件");
  });
});
