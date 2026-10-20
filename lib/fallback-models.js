/**
 * 离线兜底模型清单。
 *
 * 只在「上游一次都没成功过、本地也没有存档」时使用 —— 目标是让模型选择器
 * 至少不是空的，而不是假装这些模型一定可用。卡片上会把来源标成 `builtin`。
 *
 * 内容故意小：每个 provider 只放几个长期存在、跨账号通用的 id。名字用 id 本身，
 * 免得编造一个不存在的展示名。
 *
 * @module dsh-reverse-proxy-connect/fallback-models
 */

import { PROVIDERS } from './protocol.js'

/**
 * 兜底行：保守的窗口与输出上限，宁可算小也不要越界 400。
 *
 * `supportsImages` 默认 **false**：这张清单是「上游一次都没成功过」时用的，
 * 我们对这些模型的能力一无所知。旧默认值是 true，于是断网/首次启动时宿主会
 * 允许用户往只支持文本的模型里贴图，然后上游 400 —— 正好是 `toModelInfo()`
 * 注释里说的「比悄悄丢图更糟」的反面。真实目录里的 `supportsImages` 来自
 * 上游（Qoder `is_vl`、Trae `display.multimodal`），这里没有那个证据。
 */
function row(id, name, options = {}) {
  return {
    id,
    name,
    contextWindow: options.contextWindow ?? 128_000,
    maxTokens: options.maxTokens ?? 32_000,
    supportsImages: options.supportsImages === true,
    supportsReasoning: options.supportsReasoning ?? false,
    onlyReasoning: false,
    reasoningEfforts: [],
    canDisableThinking: false,
    credits: undefined,
    fallback: true,
  }
}

const FALLBACK = {
  // 国内版：`auto` 是虚拟 id，任何时候都能聊；其余取长期在架的几个。
  [PROVIDERS.workbuddy]: () => [
    row('auto', 'Auto', { contextWindow: 128_000, maxTokens: 32_000 }),
    row('hy3', 'Hy3', { contextWindow: 192_000, maxTokens: 64_000 }),
    row('glm-5.3', 'GLM-5.3', { contextWindow: 1_000_000, maxTokens: 64_000, supportsReasoning: true }),
    row('deepseek-v4-pro', 'DeepSeek-V4-Pro', { contextWindow: 1_000_000, maxTokens: 128_000 }),
  ],
  // 国际版：default-model 是它的「Auto」。
  [PROVIDERS.workbuddyAi]: () => [
    row('default-model', 'Auto', { contextWindow: 176_000, maxTokens: 24_000 }),
    row('fast-model', 'Fast', { contextWindow: 200_000, maxTokens: 32_000 }),
    row('balanced-model', 'Balanced', { contextWindow: 256_000, maxTokens: 32_000 }),
    row('glm-5.3', 'GLM-5.3', { contextWindow: 1_000_000, maxTokens: 48_000, supportsReasoning: true }),
  ],
  // Qoder：`cmodel` / `auto` 是它长期在架的两个键。
  [PROVIDERS.qoder]: () => [row('auto', 'Auto'), row('cmodel', 'Cantus')],
  [PROVIDERS.qoderGlobal]: () => [row('auto', 'Auto'), row('cmodel', 'Cantus')],
  // Trae：长期在架、跨套餐都能选到的几个。窗口按上游给的 `dev` 值写，
  // 宁可按小算也不要越界 400。
  [PROVIDERS.trae]: () => [
    row('glm-5.2', 'GLM-5.2', { contextWindow: 200_000, maxTokens: 48_000 }),
    row('Doubao-Seed-2.1-Turbo', 'Seed-2.1-Turbo', { contextWindow: 256_000, maxTokens: 64_000 }),
    row('DeepSeek-V4-Pro-Official', 'DeepSeek-V4-Pro', { contextWindow: 200_000, maxTokens: 48_000 }),
    row('kimi-k2.6', 'Kimi-K2.6', { contextWindow: 200_000, maxTokens: 48_000 }),
  ],
  [PROVIDERS.traeGlobal]: () => [
    row('glm-5.2', 'GLM-5.2', { contextWindow: 200_000, maxTokens: 48_000 }),
    row('Doubao-Seed-2.1-Turbo', 'Seed-2.1-Turbo', { contextWindow: 256_000, maxTokens: 64_000 }),
    row('DeepSeek-V4-Pro-Official', 'DeepSeek-V4-Pro', { contextWindow: 200_000, maxTokens: 48_000 }),
    row('kimi-k2.6', 'Kimi-K2.6', { contextWindow: 200_000, maxTokens: 48_000 }),
  ],
}

/**
 * 取某个 provider 的兜底清单。
 * @param provider - provider id。
 * @returns 模型行数组。
 */
export function fallbackModelsFor(provider) {
  return FALLBACK[provider]?.() ?? []
}
