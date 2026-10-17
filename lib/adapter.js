/**
 * DSH 适配器：把四个上游统一挂到 `ctx.llm` 上。
 *
 * ## 为什么不用 pi-ai，而是自己实现 LlmAdapter
 * 上游两个插件都走 `PiAiAdapter`，而那需要 import `@earendil-works/pi-ai`
 * （`createProvider` / `openAICompletionsApi`）。这个包是 DSH 的**传递依赖**：
 * 它装在 `app.asar` 里，profile 的 `node_modules` 顶层并没有它。插件如果自己
 * 声明它，pnpm 会再装一份副本 —— 那就是上游 workbuddy-connect 现在 0.87.1
 * 与 1.1.0 并存的那种坑。
 *
 * DSH 的 `LlmAdapter` 却是稳定且公开的：只要实现
 * `providerInfo / providerRetryPolicy / listModels / resolveModel / stream`，
 * 直接产出 `StreamChunk` 就行。这里产出的 chunk 与 pi-ai 适配器最终产出的
 * 完全一致，所以模型选择器、token 计量、压缩、工具循环都不用变。
 *
 * @module dsh-reverse-proxy-connect/adapter
 */

import { imageRequestTargetOf } from './images.js'
import { PROVIDER_META, PROVIDERS, REASON } from './protocol.js'

/**
 * 带稳定 code 的失败。
 *
 * 刻意**不** import `@deepseek-ai/dsh-llm`：那个包只存在于 DSH 的安装树里
 * （`app.asar` 内），profile 的 `node_modules` 顶层没有它，插件一旦在宿主之外
 * 被单独加载（CLI、单测）就会解析失败。DSH 只要求终态 `finish` chunk 里带
 * `failure.code`，所以这里自带一个够用的形状即可。
 */
export class LlmFailure extends Error {
  /**
   * @param message - 说明。
   * @param code - 稳定 code（AUTH / RATE_LIMIT / QUOTA / …）。
   */
  constructor(message, code) {
    super(message)
    this.name = 'LlmFailure'
    this.code = code
  }
}

/** 平台允许的思考档位顺序（由弱到强）。 */
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']

/** 档位的中文名。 */
const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }

/**
 * 把上游给的倍率文案归一成 `x0.79` / `免费`。
 *
 * 上游的原始字符串五花八门：`x0.79 credits`、`x0.00`、`0.79`。丢弃认不出的，
 * 绝不给模型凭空补一个数字 —— 错误的倍率比没有倍率更误导。
 *
 * @param raw - 原始倍率。
 * @returns 归一化文案，或 undefined。
 */
export function normalizeRateLabel(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim().replace(/\s*credits?$/i, '')
  const match = /^x?(\d+(?:\.\d+)?)$/.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  return value === 0 ? '免费' : `x${String(value)}`
}

/**
 * 模型在选择器里显示的名字。
 *
 * DSH 的模型选择器只渲染 `name`，所以倍率要拼在这里才看得见。
 * @param model - 内部模型行。
 * @param showRate - 是否拼接倍率。
 * @returns 展示名。
 */
export function displayNameOfModel(model, showRate) {
  if (!showRate) return model.name
  const rate = normalizeRateLabel(model.credits)
  if (rate === undefined) return model.name
  // 名字里已经带了同一段就不重复拼。
  if (model.name.includes(rate)) return model.name
  return `${model.name} · ${rate}`
}

/**
 * 把一个 provider 的模型行转成 DSH 的 `LlmModelInfo`。
 *
 * `inputModalities` 决定宿主会不会把图片块交给适配器：
 * 只有「模型支持图片」**且**「宿主提供了附件服务」时才能声明 image，
 * 否则宿主会把它换成文本占位符（这比悄悄丢图好）。
 *
 * @param provider - provider id。
 * @param model - 内部模型行。
 * @param showRate - 是否在名字后拼倍率。
 * @param imagesSupported - 宿主是否能解析图片附件（默认 true，保持纯函数调用方语义）。
 * @returns 模型信息。
 */
export function toModelInfo(provider, model, showRate = false, imagesSupported = true) {
  return {
    provider,
    id: model.id,
    name: displayNameOfModel(model, showRate),
    ...(model.credits === undefined ? {} : { description: model.credits }),
    inputModalities: model.supportsImages === true && imagesSupported === true ? ['text', 'image'] : ['text'],
  }
}

/**
 * 把一个 provider 的模型行转成 DSH 的 `LlmResolvedModelInfo`。
 *
 * 注意 `reasoning.efforts` 必须是「由弱到强」的顺序，且只列该模型真的支持的档位 ——
 * DSH 会用这份清单校验显式请求的 effort，不匹配就在发请求之前拒掉。
 *
 * 单档位也要照实列出：`glm-5.1` 这类只有隐含 effort 的模型，上游要求**必须显式**
 * 带 `reasoning_effort`，DSH 拿到这份单档清单才会把默认档填进去。
 *
 * @param provider - provider id。
 * @param model - 内部模型行。
 * @param showRate - 是否在名字后拼倍率。
 * @param imagesSupported - 宿主是否能解析图片附件（默认 true）。
 * @returns 精确模型信息。
 */
export function toResolvedModelInfo(provider, model, showRate = false, imagesSupported = true) {
  const efforts = [...new Set((model.reasoningEfforts ?? []).filter((effort) => EFFORT_ORDER.includes(effort)))]
  const ordered = [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
  const reasoning = ordered.length === 0
    ? undefined
    : {
        efforts: ordered.map((effort) => ({ id: effort, name: EFFORT_LABEL[effort] ?? effort })),
        ...(model.defaultEffort !== undefined && ordered.includes(model.defaultEffort) ? { defaultEffort: model.defaultEffort } : {}),
      }
  return {
    provider,
    id: model.id,
    name: displayNameOfModel(model, showRate),
    ...(model.credits === undefined ? {} : { description: model.credits }),
    inputModalities: model.supportsImages === true && imagesSupported === true ? ['text', 'image'] : ['text'],
    context: { contextWindow: model.contextWindow },
    defaultMaxTokens: model.maxTokens,
    ...(reasoning === undefined ? {} : { reasoning }),
    // 两种上游都接受历史中途的 system 消息（WorkBuddy 把它当 system，Qoder 折算成 system），
    // 所以声明 in-history，让 DSH 把后加的系统提示留在历史里而不是每次重拼。
    systemPromptUpdate: 'in-history',
  }
}

/**
 * 四个 provider 共用的适配器。
 *
 * 上游请求由注入的 `runtime` 提供：`runtime.listModels(provider)` 返回模型行，
 * `runtime.openStream(provider, request)` 返回归一化事件流。这样适配器本身
 * 对 WorkBuddy / Qoder 的差异一无所知。
 */
export class ReverseProxyAdapter {
  /**
   * @param runtime - `{ listModels, resolveModel, openStream, retryPolicy }`。
   */
  constructor(runtime) {
    this.runtime = runtime
  }

  /**
   * provider 的展示信息。
   * @param provider - provider id。
   * @returns `{id, name}`。
   */
  providerInfo(provider) {
    return { id: provider, name: PROVIDER_META[provider]?.displayName ?? provider }
  }

  /**
   * provider 自己的重试策略。软限流由上游的 429 驱动，交给 DSH 的 retry 执行器。
   * 这里返回 undefined，让 DSH 用它的默认策略（正常模式 5 次），
   * 因为本插件没有任何理由偏离宿主的默认。
   * @param _provider - provider id。
   * @returns undefined。
   */
  providerRetryPolicy(_provider) {
    return undefined
  }

  /**
   * 宿主渲染图片时的请求目标尺寸。
   *
   * 必须与运行时真正传给 `readImageRequest()` 的目标完全一致，否则宿主
   * 给模型描述的「请求预览尺寸」会和实际发出去的图对不上。
   *
   * @param _provider - provider id。
   * @param _model - 模型 id。
   * @param image - 归一化后的源图（含宽高）。
   * @returns `{width, height, maxBytes}`。
   */
  imageRequestTarget(_provider, _model, image) {
    return imageRequestTargetOf(image)
  }

  /**
   * 订阅制没有按图计价，交回 undefined 让宿主用中性估算。
   * @param _provider - provider id。
   * @param _model - 模型 id。
   * @returns undefined。
   */
  imageRequestPricing(_provider, _model) {
    return undefined
  }

  /**
   * 订阅侧订阅的模型清单。目录为空就是「该 provider 暂时不显示」，
   * 这与 DSH 的约定一致（没有模型的组会被选择器过滤掉）。
   * @param provider - provider id。
   * @returns 模型信息数组。
   */
  async listModels(provider) {
    const models = await this.runtime.listModels(provider)
    const showRate = this.runtime.showRateInModelName?.() === true
    const images = this.runtime.canAcceptImages?.() === true
    return models.map((model) => toModelInfo(provider, model, showRate, images))
  }

  /**
   * 解析一个精确模型。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param _signal - 取消。
   * @returns 精确模型信息。
   * @throws {LlmFailure} 该 provider 没有这个模型时。
   */
  async resolveModel(provider, model, _signal) {
    const found = await this.runtime.resolveModel(provider, model)
    if (found === undefined) {
      throw new LlmFailure(`provider "${provider}" 没有模型 "${model}"`, 'UNKNOWN_MODEL')
    }
    return toResolvedModelInfo(provider, found, this.runtime.showRateInModelName?.() === true, this.runtime.canAcceptImages?.() === true)
  }

  /**
   * 绑定一次调用：把模型信息与具体的流入口固定在同一代目录上。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param signal - 取消。
   * @returns 准备好的调用。
   */
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal)
    return {
      model: resolved,
      stream: (options) => this.streamWithMeta(options, resolved),
    }
  }

  /**
   * 流式调用入口（非 prepared 路径）。
   * @param options - DSH 的 GenerateOptions。
   * @returns 异步 chunk 迭代器。
   */
  stream(options) {
    return this.streamUnresolved(options)
  }

  /**
   * 未解析模型时的流入口：先解析一次拿元数据，再复用同一条路径。
   * @param options - DSH 的 GenerateOptions。
   * @yields StreamChunk。
   */
  async *streamUnresolved(options) {
    let resolved
    try {
      resolved = await this.resolveModel(options.provider, options.model, options.signal)
    } catch (error) {
      yield finishError(error)
      return
    }
    yield* this.streamWithMeta(options, resolved)
  }

  /**
   * 真正的请求：把 DSH 的请求转成上游 body，再把归一化事件转成 StreamChunk。
   * @param options - DSH 的 GenerateOptions。
   * @param meta - 已解析的模型信息（提供 maxTokens 与上下文窗口）。
   * @yields StreamChunk。
   */
  async *streamWithMeta(options, meta) {
    if (options.stop !== undefined && options.stop.length > 0) {
      // 两个上游都不保证 stop 序列语义；与其悄悄忽略，不如明确拒绝（与 pi-ai 适配器一致）。
      yield finishError(new LlmFailure('dsh-reverse-proxy-connect 不支持 GenerateOptions.stop', 'UNSUPPORTED_OPTION'))
      return
    }
    let opened
    try {
      opened = await this.runtime.openStream(options.provider, {
        model: options.model,
        messages: options.messages,
        system: options.system,
        tools: options.tools,
        toolHistory: options.toolHistory,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        reasoningEffort: options.reasoningEffort,
        sessionId: options.sessionId,
        signal: options.signal,
      })
    } catch (error) {
      yield finishError(error)
      return
    }

    let nextIndex = 0
    // 显式记住「当前打开的那个块」的下标：不能用 nextIndex-1 推算，
    // 一旦中间插进过工具块，-1 就会指到别的块上去。
    let openIndex = -1
    let openKind
    let openText = ''
    const toolBlocks = new Map()
    let usage
    let finished = false

    /** 关闭当前打开的文本/推理块（若有）。 */
    const closeOpen = function* () {
      if (openKind === undefined) return
      yield { type: 'block-end', index: openIndex, block: { type: openKind, text: openText } }
      openKind = undefined
      openIndex = -1
      openText = ''
    }

    try {
      for await (const event of opened.events) {
        if (event.type === 'text' || event.type === 'reasoning') {
          const wanted = event.type === 'text' ? 'text' : 'reasoning'
          if (openKind !== wanted) {
            yield* closeOpen()
            openIndex = nextIndex++
            openKind = wanted
            openText = ''
            yield { type: 'block-start', index: openIndex, blockType: wanted }
          }
          openText += event.text
          yield { type: wanted === 'text' ? 'text-delta' : 'reasoning-delta', index: openIndex, text: event.text }
          continue
        }
        if (event.type === 'tool') {
          // 工具调用会打断正在进行的文本/思考块。
          yield* closeOpen()
          let block = toolBlocks.get(event.index)
          if (block === undefined) {
            block = {
              blockIndex: nextIndex++,
              id: event.id === '' ? `call-${String(event.index)}` : event.id,
              name: event.name,
              arguments: '',
            }
            toolBlocks.set(event.index, block)
            yield {
              type: 'tool-call-delta',
              index: block.blockIndex,
              id: block.id,
              ...(block.name === '' ? {} : { name: block.name }),
              argumentsDelta: event.argumentsDelta,
            }
          } else {
            if (event.id !== '' && block.id.startsWith('call-')) block.id = event.id
            if (event.name !== '' && block.name === '') block.name = event.name
            yield {
              type: 'tool-call-delta',
              index: block.blockIndex,
              id: block.id,
              ...(block.name === '' ? {} : { name: block.name }),
              argumentsDelta: event.argumentsDelta,
            }
          }
          block.arguments += event.argumentsDelta
          continue
        }
        if (event.type === 'usage') {
          usage = event.usage
          continue
        }
        if (event.type === 'finish') {
          finished = true
          yield* closeOpen()
          for (const block of toolBlocks.values()) {
            yield {
              type: 'block-end',
              index: block.blockIndex,
              block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments },
            }
          }
          const sawTools = toolBlocks.size > 0
          toolBlocks.clear()
          const total = usage === undefined ? undefined : usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
          yield { type: 'usage', usage: usage === undefined ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } : { ...usage, totalTokens: total } }
          yield { type: 'finish', reason: { kind: sawTools && event.kind === 'stop' ? 'tool-calls' : event.kind } }
          return
        }
      }
      // 上游没给终端事件就断了：当成正常结束，但补齐 usage/finish，否则调用方会悬着。
      if (!finished) {
        yield* closeOpen()
        const sawTools = toolBlocks.size > 0
        for (const block of toolBlocks.values()) {
          yield { type: 'block-end', index: block.blockIndex, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments } }
        }
        toolBlocks.clear()
        const total = usage === undefined ? 0 : usage.inputTokens + usage.outputTokens
        yield { type: 'usage', usage: usage === undefined ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } : { ...usage, totalTokens: total } }
        yield { type: 'finish', reason: { kind: sawTools ? 'tool-calls' : 'stop' } }
      }
    } catch (error) {
      // 中途失败时也要把已经打开的块关掉：DSH 的渲染器按 block-start/block-end
      // 配对，只发 finish 会留下一个永远不结束的文本/工具块。
      yield* closeOpen()
      for (const block of toolBlocks.values()) {
        yield {
          type: 'block-end',
          index: block.blockIndex,
          block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments },
        }
      }
      toolBlocks.clear()
      yield finishError(error)
    } finally {
      try {
        await opened?.close?.()
      } catch {
        /* 关闭失败不影响已经产出的内容 */
      }
    }
  }
}

/**
 * 把任意错误转成一个终态 finish chunk（DSH 的协议要求每个流以 finish 结束）。
 * @param error - 抛出来的错误。
 * @returns finish chunk。
 */
function finishError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error?.kind === 'string'
    ? failureCode(error.kind)
    : typeof error?.code === 'string'
      ? stableFailureCode(error.code)
      : REASON.upstreamError
  const aborted = error?.name === 'AbortError' || code === 'ABORTED'
  return {
    type: 'finish',
    reason: aborted
      ? { kind: 'aborted', failure: { message, code: 'ABORTED' } }
      : { kind: 'error', failure: { message, code } },
  }
}

/**
 * 把插件内部错误码收敛成 DSH 认识的稳定 failure code。
 *
 * `finish` chunk 会进入宿主的错误分类（重试、UI 文案、遥测），所以不能把
 * `image-unavailable`、`pat-invalid` 这类内部码原样透出去。
 *
 * @param code - 内部码。
 * @returns DSH 稳定码。
 */
export function stableFailureCode(code) {
  switch (code) {
    case 'ABORTED':
    case 'TIMEOUT':
    case 'AUTH':
    case 'QUOTA':
    case 'RATE_LIMIT':
    case 'SERVER':
    case 'MALFORMED_RESPONSE':
    case 'IMAGE_UNAVAILABLE':
      return code
    case 'aborted':
      return 'ABORTED'
    case 'timeout':
      return 'TIMEOUT'
    case 'auth':
    case 'pat-invalid':
    case 'no-credential':
    case 'credential-unreadable':
    case 'credential-expired':
    case 'app-not-found':
    case 'app-ambiguous':
    case 'app-path-invalid':
    case 'region-mismatch':
      return 'AUTH'
    case 'quota':
      return 'QUOTA'
    case 'soft-rate':
      return 'RATE_LIMIT'
    case 'server':
      return 'SERVER'
    case 'malformed':
      return 'MALFORMED_RESPONSE'
    case 'image-unavailable':
      return 'IMAGE_UNAVAILABLE'
    default:
      return REASON.upstreamError
  }
}

/**
 * 上游的 failure kind → DSH 的稳定 failure code。
 * @param kind - 上游种类。
 * @returns DSH failure code。
 */
export function failureCode(kind) {
  switch (kind) {
    case 'soft-rate':
      return 'RATE_LIMIT'
    case 'quota':
      return 'QUOTA'
    case 'auth':
      return 'AUTH'
    case 'timeout':
      return 'TIMEOUT'
    case 'server':
      return 'SERVER'
    case 'malformed':
      return 'MALFORMED_RESPONSE'
    default:
      return REASON.upstreamError
  }
}

export { PROVIDERS }
