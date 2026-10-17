/**
 * 图片输入的工具函数。
 *
 * DSH 的 `ImageBlock` 里携带的是一个**持久引用**（`ImageAttachmentRef`），
 * 适配器必须自己把它换成一次请求用的字节。这里集中放三件事：
 *
 * 1. 从消息里收集引用（去重、跳过已 offload 的）；
 * 2. 决定请求尺寸与字节上限（必须和 `imageRequestTarget()` 完全一致，
 *    否则宿主的坐标映射会和真正发出去的图对不上）；
 * 3. 生成模型看得懂的说明文本（与 DSH 自己的措辞保持一致，
 *    让模型在两种 adapter 之间迁移时看到同样形状的提示）。
 *
 * 这个模块不依赖任何服务，纯函数，方便单测。
 *
 * @module dsh-reverse-proxy-connect/images
 */

import { REASON } from './protocol.js'

/**
 * 默认的请求图片预算。
 *
 * 4M 像素约等于 2048×2048，是主流视觉模型都能稳定接受的量级；4MB 字节上限
 * 覆盖 PNG 截图与 JPEG 照片。两个值都刻意比宿主允许的**源图**上限小，
 * 因为请求版本会在本地重新编码。
 */
export const DEFAULT_IMAGE_BUDGET = Object.freeze({
  maxPixels: 4_194_304,
  maxBytes: 4_000_000,
  maxDimension: 4096,
})

/** 安全正整数。 */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

/**
 * 算出一次请求该发多大的图。
 *
 * 与 `@deepseek-ai/dsh-attachment` 的 `requestImageDimensions()` 同一语义：
 * 保持宽高比，同时受总像素与单边上限约束；**不放大**。
 *
 * @param image - `{width, height}`（源图的归一化尺寸）。
 * @param budget - `{maxPixels, maxBytes, maxDimension}`。
 * @returns `{width, height, maxBytes}`，可直接交给 `readImageRequest()`。
 */
export function imageRequestTargetOf(image, budget = DEFAULT_IMAGE_BUDGET) {
  const width = positive(image?.width) ?? 1
  const height = positive(image?.height) ?? 1
  const maxPixels = positive(budget?.maxPixels) ?? DEFAULT_IMAGE_BUDGET.maxPixels
  const maxDimension = positive(budget?.maxDimension) ?? DEFAULT_IMAGE_BUDGET.maxDimension
  const maxBytes = positive(budget?.maxBytes) ?? DEFAULT_IMAGE_BUDGET.maxBytes
  let scale = 1
  const pixels = width * height
  if (pixels > maxPixels) scale = Math.min(scale, Math.sqrt(maxPixels / pixels))
  const longEdge = Math.max(width, height)
  if (longEdge > maxDimension) scale = Math.min(scale, maxDimension / longEdge)
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    maxBytes,
  }
}

/**
 * 从 DSH 的消息数组里收集所有未 offload 的图片引用。
 *
 * @param messages - `RequestMessage[]`。
 * @returns 去重后的引用数组（按出现顺序）。
 */
export function collectImageRefs(messages) {
  const seen = new Set()
  const refs = []
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block === null || typeof block !== 'object' || block.type !== 'image') continue
      if (block.offloaded === true) continue
      const ref = block.attachment
      if (ref === null || typeof ref !== 'object') continue
      const id = typeof ref.attachmentId === 'string' ? ref.attachmentId : ''
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      refs.push(ref)
    }
  }
  return refs
}

/**
 * 一张请求图片的说明文本。
 *
 * 保留 DSH 自己的关键信息（附件 id、请求尺寸、只读路径），因为模型在
 * 「看图」之外还经常需要用文件工具去找原图。
 *
 * @param image - `{attachmentId, name?, width, height, mediaType, readonlyPath?}`。
 * @returns 英文说明（模型面向的文案统一用英文，与宿主一致）。
 */
export function imageHandleText(image) {
  const id = typeof image?.attachmentId === 'string' ? image.attachmentId : 'unknown'
  const name = typeof image?.name === 'string' && image.name !== '' ? JSON.stringify(image.name) : undefined
  const identity = name === undefined ? id : `${name} (${id})`
  const width = positive(image?.width) ?? 0
  const height = positive(image?.height) ?? 0
  let text = `Image ${identity}; request preview ${String(width)}x${String(height)}px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
  if (typeof image?.readonlyPath === 'string' && image.readonlyPath !== '') {
    text += ` Normalized copy (read-only; may be resized or re-encoded): ${JSON.stringify(image.readonlyPath)} (${String(image.mediaType)}). Source dimensions, format, and byte size may differ. Copy to a writable path ending in ${extensionOf(image.mediaType)} before editing.`
  }
  return text
}

/** 媒体类型 → 扩展名。 */
function extensionOf(mediaType) {
  switch (mediaType) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    default:
      return '.png'
  }
}

/**
 * 把 `readImageRequest()` 的结果转成 data URL。
 * @param version - `{mediaType, data}`。
 * @returns `data:image/...;base64,...`。
 */
export function imageDataUrl(version) {
  const mediaType = typeof version?.mediaType === 'string' ? version.mediaType : 'image/png'
  const bytes = version?.data instanceof Uint8Array ? version.data : Buffer.from(version?.data ?? [])
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
}

/** 图片读取失败（与模型请求失败分开，便于诊断）。 */
export class ImageReadError extends Error {
  /**
   * @param message - 说明。
   * @param cause - 底层错误。
   */
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ImageReadError'
    this.code = REASON.imageUnavailable
  }
}
