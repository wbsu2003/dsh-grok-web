/**
 * DSH LLM adapter：把 grok.com 网页端包装成 provider `grok-web`。
 *
 * 鸭子类型满足 dsh-llm 的 LlmAdapter 契约（不继承基类）：
 * providerInfo / providerRetryPolicy / imageRequestPricing / listModels /
 * resolveModel / prepareCall / stream。
 */
import { describeAuth, readAuth } from './auth.js'
import {
  defaultTier,
  findTier,
  listableTiers,
  modelInfo,
  normalizeConfig,
  resolvedModelInfo,
  unwrapConfig,
} from './config.js'
import { abortError, GrokError } from './errors.js'
import { streamMgw } from './mgw.js'
import { estimateTokens, serializePromptParts, ToolCallStreamFilter } from './protocol.js'
import { resolveProxy } from './proxy.js'

export const PROVIDER = 'grok-web'

/**
 * 重试策略必须是**扁平**对象（dsh-llm 的消费方直接读这几个字段）；
 * 返回 undefined 会落到默认 maxDelayMs=10s，长退避会被直接放弃。
 *
 * AUTH 刻意不在可重试集合里：本插件没有换号机制，重试一个已失效的凭证
 * 只会白打请求；让用户看到明确的「重新登录」更合适。
 */
export const RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 3_000,
  maxDelayMs: 65_000,
  jitterRatio: 0.2,
})

function normalizeLogger(logger) {
  if (!logger) return {}
  return {
    info: typeof logger.info === 'function' ? (message) => logger.info(message) : undefined,
    warn: typeof logger.warn === 'function' ? (message) => logger.warn(message) : undefined,
    debug: typeof logger.debug === 'function' ? (message) => logger.debug(message) : undefined,
  }
}

function isAbort(error) {
  return error instanceof GrokError && error.code === 'ABORTED'
}

/**
 * @param {object} [options]
 * @param {object} [options.config] - 插件设置节（volatile 活引用，每次读取前重新摊平）
 * @param {object} [options.logger]
 * @param {Function} [options.runMgw] - 单测注入
 * @param {Function} [options.readAuth] - 单测注入
 */
export function createAdapter(options = {}) {
  // 设置页保存后 volatile 配置就地换值，所以 config 不能只 normalize 一次；
  // 每个对外入口都先 refresh()，本轮请求读到的一定是当前设置。
  const source = () => normalizeConfig(unwrapConfig(options.config))
  let config = source()
  const refresh = () => {
    config = source()
    return config
  }
  const logger = normalizeLogger(options.logger)
  const runMgw = options.runMgw ?? streamMgw
  const loadAuth = options.readAuth ?? readAuth

  async function* streamImpl(generateOptions = {}) {
    refresh()
    const signal = generateOptions.signal
    if (signal?.aborted) throw abortError()

    const auth = loadAuth(config)
    if (auth.expiredCookies?.length) {
      logger.warn?.(
        `grok-web: 登录态里有已过期的 cookie（${auth.expiredCookies.join(', ')}）；如果请求被拒，请重新运行 scripts/login.mjs`,
      )
    }

    let proxy = { url: '', source: 'direct' }
    try {
      proxy = resolveProxy({ configProxy: config.proxy, targetUrl: 'wss://grok.com/' })
    } catch (error) {
      throw new GrokError(`代理配置无效：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
    }

    const purpose = generateOptions.purpose
    // 档位：DSH 传的是 model id（如 grok-web-auto），设置里的 model 是默认档
    const tier = findTier(generateOptions.model) ?? defaultTier(config)
    const tools = Array.isArray(generateOptions.tools) ? generateOptions.tools : []
    // 标题生成 / 上下文压缩不需要工具；不把工具目录塞进去，省体量也避免它去调工具。
    const toolsForPrompt = purpose === 'session-title' || purpose === 'compaction' ? [] : tools
    const promptParts = serializePromptParts({
      system: generateOptions.system,
      messages: generateOptions.messages ?? [],
      tools: toolsForPrompt,
      maxChars: config.maxPromptChars,
      serialToolCalls: config.serialToolCalls,
    })

    const startedAt = Date.now()
    const filter = new ToolCallStreamFilter()
    let firstTextAt = 0
    let textIndex = -1
    let textClosed = true
    let textContent = ''
    let totalText = ''
    let nextBlockIndex = 0
    let toolCallCount = 0
    let endReason = 'stop'
    let sessionId = ''
    let eventCount = 0

    const closeTextBlock = function* () {
      if (textIndex < 0 || textClosed) return
      textClosed = true
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textContent } }
    }

    const openTextBlock = function* () {
      if (textIndex >= 0 && !textClosed) return
      textIndex = nextBlockIndex
      nextBlockIndex += 1
      textClosed = false
      textContent = ''
      yield { type: 'block-start', index: textIndex, blockType: 'text' }
    }

    const emitOutput = function* (output) {
      if (output.text) {
        yield* openTextBlock()
        textContent += output.text
        totalText += output.text
        if (!firstTextAt) firstTextAt = Date.now()
        yield { type: 'text-delta', index: textIndex, text: output.text }
      }
      if (output.calls.length > 0) yield* closeTextBlock()
      for (const call of output.calls) {
        const index = nextBlockIndex
        nextBlockIndex += 1
        toolCallCount += 1
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: call.arguments,
        }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
        }
      }
    }

    if (config.debug) {
      logger.info?.(
        `grok-web: 发起请求 provider=${PROVIDER} model=${tier.model} purpose=${purpose ?? 'chat'} ` +
          `prompt=${promptParts.full.length}字 tools=${toolsForPrompt.length} proxy=${proxy.url ? `${proxy.source}:${proxy.url}` : proxy.source}`,
      )
    }

    try {
      for await (const event of runMgw({
        auth,
        prompt: promptParts.full,
        model: tier.model,
        signal,
        proxy: proxy.url,
        idleTimeoutMs: config.idleTimeoutMs,
        totalTimeoutMs: config.totalTimeoutMs,
        heartbeatMs: config.heartbeatMs,
        connectTimeoutMs: config.connectTimeoutMs,
        logger,
        debug: config.debug,
      })) {
        if (signal?.aborted) throw abortError()
        if (event.kind === 'ready') {
          sessionId = event.sessionId
          logger.info?.(`grok-web: mgw 会话已建立 session=${sessionId}（auth=${describeAuth(auth).source}）`)
          continue
        }
        if (event.kind === 'text') {
          eventCount += 1
          yield* emitOutput(filter.push(event.text))
          continue
        }
        if (event.kind === 'end') {
          endReason = event.reason
          break
        }
      }

      if (signal?.aborted) throw abortError()
      yield* emitOutput(filter.flush())

      if (filter.rejected && toolCallCount === 0) {
        const reason = filter.rejected.reason === 'unbalanced' ? '输出被截断，协议块没收全' : '调用格式无法解析'
        logger.warn?.(
          `grok-web: 工具调用${reason}，已丢弃 ${filter.rejected.raw.length} 字符（不会作为正文上屏）`,
        )
        yield* closeTextBlock()
        const inputTokens = estimateTokens(promptParts.full)
        const outputTokens = estimateTokens(totalText)
        yield {
          type: 'usage',
          usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        }
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: `Grok 网页端本次的调用格式无法解析（${reason}），已丢弃并自动重试；无需处理。`,
              code: 'EMPTY_RESPONSE',
            },
          },
        }
        return
      }
      if (filter.rejected && toolCallCount > 0) {
        logger.warn?.(`grok-web: 本轮有调用被丢弃（${filter.rejected.reason ?? 'unparsable'}），但已成功提取到其它调用，继续执行`)
      }

      yield* closeTextBlock()

      const inputTokens = estimateTokens(promptParts.full)
      const outputTokens = estimateTokens(totalText)
      yield {
        type: 'usage',
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      }

      if (toolCallCount > 0) {
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else if (!totalText.trim()) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: 'Grok 网页端返回了空响应（可能额度用尽、账号受限或登录态失效）',
              code: 'EMPTY_RESPONSE',
            },
          },
        }
      } else if (endReason === 'truncated') {
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      } else {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }

      const elapsed = Date.now() - startedAt
      const ttfb = firstTextAt ? firstTextAt - startedAt : -1
      logger.info?.(
        `grok-web: 完成 [${elapsed}ms, 首字 ${ttfb >= 0 ? `${ttfb}ms` : 'n/a'}] ` +
          `prompt=${promptParts.full.length}字 / 正文=${totalText.length}字 / 调用=${toolCallCount} / ` +
          `事件=${eventCount} / 结束=${endReason}`,
      )
    } catch (error) {
      yield* closeTextBlock()
      if (signal?.aborted || isAbort(error)) throw abortError()
      if (error instanceof GrokError) {
        // 未实测档位（免费账号选 Expert / Heavy）在服务端的表现就是「这轮没有正文」，
        // 只报 EMPTY_RESPONSE 会被当成登录失效，这里把档位原因直说。
        if (error.code === 'EMPTY_RESPONSE' && !tier.verified) {
          throw new GrokError(
            `${error.message}；本档 ${tier.model} 未实测（网页端 Expert / Heavy 需要付费档，免费账号会静默返回空响应）`,
            error.code,
            { cause: error },
          )
        }
        throw error
      }
      throw new GrokError(`grok-web 流失败：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
    }
  }

  return {
    providerInfo(provider) {
      return { id: String(provider || PROVIDER), name: 'Grok 网页版（免费）' }
    },

    providerRetryPolicy() {
      return RETRY_POLICY
    },

    // 必须有：注册表在计量/压缩路径上会无条件转调；返回 undefined 表示本路由不声明图片计价。
    imageRequestPricing() {
      return undefined
    },

    listModels(provider) {
      refresh()
      const ids = String(provider || PROVIDER)
      return Promise.resolve(listableTiers(config).map((tier) => modelInfo(config, ids, tier)))
    },

    resolveModel(provider, model) {
      refresh()
      const ids = String(provider || PROVIDER)
      const tier = findTier(model)
      if (model && !tier && config.debug) {
        logger.info?.(`grok-web: 未知模型 id "${model}"，回落到默认档 ${defaultTier(config).id}`)
      }
      return Promise.resolve(resolvedModelInfo(config, ids, tier ?? defaultTier(config)))
    },

    prepareCall(provider, model, signal) {
      refresh()
      if (signal?.aborted) return Promise.reject(abortError())
      const ids = String(provider || PROVIDER)
      const tier = findTier(model) ?? defaultTier(config)
      const info = resolvedModelInfo(config, ids, tier)
      return Promise.resolve({
        model: info,
        // 档位在这里定死，再随 options 传下去：stream 的 options.model 未必会被宿主回填
        stream: (generateOptions) => streamImpl({ ...generateOptions, model: info.id }),
      })
    },

    stream(generateOptions) {
      return streamImpl(generateOptions)
    },
  }
}
