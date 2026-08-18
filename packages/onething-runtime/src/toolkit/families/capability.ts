/**
 * R3a 家族基类 —— `CapabilityTool`(§4 的第九族)。
 *
 * 这一族改的是"助手够得着什么"。两件事归家族:
 *
 *  1. **场景面挂在一个 skill 上**。成员由某个 skill「带进来」:该 skill 在本回合
 *     启用时可见,否则不见。判据与旧 `scene-surface.ts` 的 `SKILL_SCENE_TOOLS`
 *     逐字一致(键是 SKILL.md frontmatter 里的 `name`,不是带 source 前缀的 id)。
 *  2. **`capability_change` 的口径**。它是 core `NEVER_GRANTABLE_TYPES` 里唯一的
 *     成员 —— 每挂一次问一次,答案永不可记住。**不新增 effect kind**:加一个
 *     `feature_mount` kind 就是"功能形状的洞"(D3 第一条禁止的事),而
 *     `capability_change` 的定义原文说的正是这件事。
 *
 * 默认的 `plan` 是 `Intent.none`(`feature_unmount` / `feature_inspect` 就是这一格
 * ——它们不执行模型写的代码,与 mount 不对称是有意的:危险的是"让代码跑起来",
 * 不是"让它停下来")。要报效果的成员覆盖 `effectsFor`。
 */

import { Intent, Tool } from '@onething/core/toolkit'
import type { Effect, PlanContext, Preview, Result, RunContext, Scene } from '@onething/core/toolkit'

export abstract class CapabilityTool<In, Payload = In> extends Tool<In, Payload> {
  /** 带这只工具进场的 skill 名字。`undefined` = 不挂任何 skill,到处成立。 */
  protected readonly requiredSkill?: string

  visibleIn(scene: Scene): boolean {
    if (!this.requiredSkill) return true
    return (scene.skills ?? []).includes(this.requiredSkill)
  }

  async plan(input: In, ctx: PlanContext): Promise<Intent<Payload>> {
    const payload = this.payloadFor(input, ctx)
    const effects = this.effectsFor(input)
    if (effects.length === 0) return Intent.none(payload)
    const preview = this.previewFor(input)
    return Intent.of({ effects, ...(preview ? { preview } : {}), payload })
  }

  async apply(intent: Intent<Payload>, ctx: RunContext): Promise<Result> {
    return await this.perform(intent.payload, ctx)
  }

  protected effectsFor(_input: In): Effect[] {
    return []
  }

  protected previewFor(_input: In): Preview | undefined {
    return undefined
  }

  protected payloadFor(input: In, _ctx: PlanContext): Payload {
    return input as unknown as Payload
  }

  protected abstract perform(payload: Payload, ctx: RunContext): Promise<Result>
}

/** 自进化三件套挂的那个内置 skill(默认关闭,设置 → Skills 打开即进场景)。 */
export const SELF_EVOLUTION_SKILL_NAME = 'onething-self-evolution'
