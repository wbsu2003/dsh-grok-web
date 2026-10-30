import { defaultAuthFile } from './auth.js'

export const MODEL_ID = 'grok-web'
export const GROK_WS_URL = 'wss://grok.com/ws/mgw/'
export const RESPONSE_CHANNEL = 'CHANNEL_ASSISTANT_RESPONSE'
export const DONE_EVENTS = new Set(['response.done', 'response.completed'])

/**
 * 网页端选择器里的档位（Fast / Build / Auto / Expert / Heavy）。
 *
 * `model` 是 mgw `session.create` 里的服务端档位名，不是 DSH 的 model id。
 * `verified` 的含义很硬：只有用同一句极短 prompt 真机拿到过正文的档位才为 true。
 * 档位名在建会话阶段**不校验**（乱写也回 session.created，且原样回显），
 * 所以「接受」不等于存在；只有出正文/被空响应打断才能分辨（见 scripts/models.mjs）。
 */
export const TIERS = Object.freeze([
  { id: MODEL_ID, model: 'fast', label: 'Fast', verified: true, note: '默认档，响应最快' },
  { id: 'grok-web-auto', model: 'auto', label: 'Auto', verified: true, note: '由网页端自行挑选模型' },
  { id: 'grok-web-build', model: 'build', label: 'Build', verified: true, note: '偏代码/改动的档位' },
  { id: 'grok-web-expert', model: 'expert', label: 'Expert', verified: false, note: '免费账号实测只回空响应（网页端 Expert 属于 Premium 解锁）' },
  { id: 'grok-web-heavy', model: 'heavy', label: 'Heavy', verified: false, note: '免费账号实测只回空响应（网页端 Heavy 属于 Premium 解锁）' },
])

/** 按 DSH model id 或服务端档位名找档位；找不到返回 undefined。 */
export function findTier(value) {
  const name = String(value ?? '').trim().toLowerCase()
  if (!name) return undefined
  return TIERS.find((tier) => tier.id === name || tier.model === name)
}

/** 默认档：设置里的 `model` 决定；写了没登记的档位名也照旧生效（保留手工试错能力）。 */
export function defaultTier(config) {
  return findTier(config?.model) ?? { id: MODEL_ID, model: config?.model || 'fast', label: config?.model || 'fast', verified: false, note: '来自配置的自定义档位名' }
}

/** 设置页/模型选择器要列出的档位：实测过的，加上配置里显式指定的那一档。 */
export function listableTiers(config) {
  const chosen = defaultTier(config)
  return TIERS.filter((tier) => tier.verified || tier.model === chosen.model || tier === chosen)
}

export const DEFAULTS = Object.freeze({
  authFile: '',
  cookie: '',
  userId: '',
  userAgent: '',
  proxy: 'auto',
  model: 'fast',
  contextWindow: 131_072,
  defaultMaxTokens: 16_384,
  maxPromptChars: 200_000,
  idleTimeoutMs: 15_000,
  totalTimeoutMs: 300_000,
  heartbeatMs: 30_000,
  connectTimeoutMs: 20_000,
  serialToolCalls: true,
  debug: false,
})

function boundedInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/**
 * 把 DSH 设置页的 volatile 活引用摊平成普通对象。
 * 设置页保存后这些引用会就地换值，所以每次读取都要重新摊平，不能缓存结果。
 */
export function unwrapConfig(config) {
  if (config === null || typeof config !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return out
}

export function normalizeConfig(config = {}) {
  const input = config && typeof config === 'object' ? config : {}
  const serverModel = String(input.model ?? DEFAULTS.model).trim() || DEFAULTS.model
  return {
    authFile: String(input.authFile ?? '').trim() || defaultAuthFile(),
    cookie: typeof input.cookie === 'string' ? input.cookie.trim() : '',
    userId: String(input.userId ?? '').trim(),
    userAgent: String(input.userAgent ?? '').trim(),
    proxy: input.proxy === undefined || input.proxy === null ? DEFAULTS.proxy : input.proxy,
    model: serverModel,
    contextWindow: boundedInteger(input.contextWindow, DEFAULTS.contextWindow, 8_192, 2_000_000),
    defaultMaxTokens: boundedInteger(input.defaultMaxTokens, DEFAULTS.defaultMaxTokens, 256, 131_072),
    maxPromptChars: boundedInteger(input.maxPromptChars, DEFAULTS.maxPromptChars, 20_000, 1_500_000),
    idleTimeoutMs: boundedInteger(input.idleTimeoutMs, DEFAULTS.idleTimeoutMs, 2_000, 300_000),
    totalTimeoutMs: boundedInteger(input.totalTimeoutMs, DEFAULTS.totalTimeoutMs, 10_000, 1_800_000),
    heartbeatMs: boundedInteger(input.heartbeatMs, DEFAULTS.heartbeatMs, 5_000, 120_000),
    connectTimeoutMs: boundedInteger(input.connectTimeoutMs, DEFAULTS.connectTimeoutMs, 3_000, 120_000),
    serialToolCalls: input.serialToolCalls !== false,
    debug: input.debug === true,
  }
}

export function modelInfo(config, provider, tier = defaultTier(config)) {
  return {
    provider,
    id: tier.id,
    name: `Grok 网页版 · ${tier.label}`,
    description:
      `grok.com 网页端的免费额度（使用浏览器登录态），档位 ${tier.model}。${tier.note ?? ''} ` +
      '文本输入；工具调用由提示词协议桥接，不是原生 function calling。',
    inputModalities: ['text'],
  }
}

export function resolvedModelInfo(config, provider, tier = defaultTier(config)) {
  return {
    ...modelInfo(config, provider, tier),
    context: { contextWindow: config.contextWindow },
    defaultMaxTokens: config.defaultMaxTokens,
  }
}
