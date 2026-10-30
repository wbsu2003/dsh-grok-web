/**
 * Grok mgw WebSocket 协议层。
 *
 * 状态机（Web2Chat 真机录制）：
 *   connect wss://grok.com/ws/mgw/?uid=<x-userid>
 *   → session.create（is_temporary，模型 fast）
 *   → session.created（服务端给 session_id）
 *   → response.create（input_chunks 里放整段 prompt）
 *   → 流式 response.chunk（只收 CHANNEL_ASSISTANT_RESPONSE）
 *   → response.done / response.completed
 *
 * 每轮都是新临时会话、全量重发转写 —— 网页端不保留上下文，也就不会出现
 * 「服务端历史 + 重发历史」两份上下文打架。
 */
import { randomUUID } from 'node:crypto'
import { createAsyncQueue } from './async-queue.js'
import { DONE_EVENTS, GROK_WS_URL, RESPONSE_CHANNEL } from './config.js'
import { abortError, GrokError } from './errors.js'
import { connectWebSocket } from './ws.js'

const MAX_SEEN_TYPES = 32

const uuid = () => (typeof randomUUID === 'function' ? randomUUID() : `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`)

export function sessionCreateFrame(model) {
  return JSON.stringify({
    event: {
      type: 'session.create',
      event_id: uuid(),
      session: {
        model: model || 'fast',
        x_grok: {
          protocol_capabilities: ['conversation_attached', 'custom_methods_v1'],
          use_chunk: true,
          enable_image_generation: true,
          image_generation_count: 2,
          disable_artifact: true,
          force_concise: false,
          keep_context: false,
          is_temporary: true,
          disable_memory: true,
        },
      },
    },
  })
}

export function responseCreateFrame(sessionId, prompt) {
  return JSON.stringify({
    session_id: sessionId,
    event: {
      type: 'response.create',
      event_id: uuid(),
      item: {
        type: 'message',
        role: 'user',
        x_grok: {
          client_message_id: uuid(),
          input_chunks: [{ text: { text: prompt } }],
        },
      },
    },
  })
}

export function heartbeatFrame() {
  return JSON.stringify({ event: { type: 'ping', event_id: uuid() } })
}

function wsUrlWithUid(baseUrl, userId) {
  const url = new URL(baseUrl || GROK_WS_URL)
  url.searchParams.set('uid', userId)
  return url.toString()
}

function headersFor(auth) {
  return {
    Cookie: auth.cookieHeader,
    'User-Agent': auth.userAgent,
    Origin: 'https://grok.com',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
}

function errorDetail(payload) {
  const error = payload?.error ?? payload?.event?.error ?? payload?.response?.error ?? {}
  const code = String(error.code ?? payload?.code ?? 'unknown')
  const message = String(error.message ?? payload?.message ?? errorDetailFallback(payload))
  return { code, message }
}

function errorDetailFallback(payload) {
  try {
    return JSON.stringify(payload).slice(0, 500)
  } catch {
    return 'upstream error'
  }
}

function classifyUpstreamError(code, message) {
  const text = `${code} ${message}`
  if (/context|too long|maximum context|token limit exceeded/i.test(text)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (/unauth|unauthor|forbidden|auth|login|session expired|invalid token|not logged/i.test(text)) return 'AUTH'
  if (/quota|usage|limit|rate|too many|throttl/i.test(text)) return 'RATE_LIMIT'
  if (/overload|server|internal|unavailable|timeout|try again/i.test(text)) return 'SERVER'
  return 'PROTOCOL'
}

function upstreamError(payload, seenTypes) {
  const { code, message } = errorDetail(payload)
  const mapped = classifyUpstreamError(code, message)
  const seen = [...seenTypes].join(',')
  return new GrokError(`Grok 返回错误：${message}（${code}）[events=${seen || 'none'}]`, mapped)
}

/**
 * 跑一轮对话。
 *
 * @param {object} options
 * @param {{cookieHeader: string, userId: string, userAgent: string}} options.auth
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.proxy]
 * @param {number} [options.idleTimeoutMs]
 * @param {number} [options.totalTimeoutMs]
 * @param {number} [options.heartbeatMs]
 * @param {number} [options.connectTimeoutMs]
 * @param {string} [options.wsUrl]
 * @param {Function} [options.connect] - 单测注入
 * @param {object} [options.logger]
 * @param {boolean} [options.debug]
 * @yields {{kind:'ready', sessionId: string} | {kind:'text', text: string} |
 *   {kind:'end', reason:'stop'|'idle'|'truncated', responseId?: string}}
 */
export async function* streamMgw(options) {
  const auth = options.auth
  if (!auth?.cookieHeader || !auth?.userId) {
    throw new GrokError('缺少 Grok 登录态（cookie / userId）', 'MISSING_CREDENTIAL')
  }
  const signal = options.signal
  if (signal?.aborted) throw abortError()

  const idleTimeoutMs = Math.max(1000, Number(options.idleTimeoutMs) || 15_000)
  const totalTimeoutMs = Math.max(idleTimeoutMs, Number(options.totalTimeoutMs) || 300_000)
  const heartbeatMs = Math.max(5000, Number(options.heartbeatMs) || 30_000)
  const connectTimeoutMs = Math.max(3000, Number(options.connectTimeoutMs) || 20_000)
  const connect = options.connect ?? connectWebSocket
  const url = wsUrlWithUid(options.wsUrl || GROK_WS_URL, auth.userId)

  const connection = await connect(url, {
    headers: headersFor(auth),
    proxy: options.proxy || '',
    timeoutMs: connectTimeoutMs,
  })

  const queue = createAsyncQueue()
  const seenTypes = new Set()
  let sessionId = ''
  let sentPrompt = false
  let content = ''
  let finished = false
  let idleTimer
  let totalTimer
  let heartbeatTimer

  const clearTimer = (timer) => {
    if (timer) clearTimeout(timer)
  }
  const clearHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }
  const armIdleTimer = () => {
    clearTimer(idleTimer)
    idleTimer = setTimeout(() => queue.push({ __idle: true }), idleTimeoutMs)
    idleTimer.unref?.()
  }
  const stopAllTimers = () => {
    clearTimer(idleTimer)
    clearTimer(totalTimer)
    clearHeartbeat()
  }

  const onMessage = (text, isBinary) => {
    if (isBinary || finished) return
    let message
    try {
      message = JSON.parse(String(text))
    } catch {
      if (options.debug) options.logger?.info?.(`grok-web: 忽略非 JSON 帧（${String(text).slice(0, 120)}）`)
      return
    }
    if (!message || typeof message !== 'object') return
    const event = message.event || {}
    if (typeof event.type === 'string' && /^[a-z_.]{1,64}$/.test(event.type) && seenTypes.size < MAX_SEEN_TYPES) {
      seenTypes.add(event.type)
    }
    queue.push({ message, event })
  }
  const onError = (error) => {
    if (finished) return
    queue.fail(
      error instanceof GrokError
        ? error
        : new GrokError(`grok-web WebSocket 错误：${error?.message ?? error}`, 'TRANSPORT', { cause: error }),
    )
  }
  const onClose = (info) => {
    if (finished) return
    queue.push({ __closed: info || {} })
  }
  const onAbort = () => queue.push({ __abort: true })

  connection.on('message', onMessage)
  connection.on('error', onError)
  connection.on('close', onClose)
  signal?.addEventListener('abort', onAbort, { once: true })

  totalTimer = setTimeout(() => queue.push({ __total: true }), totalTimeoutMs)
  totalTimer.unref?.()
  heartbeatTimer = setInterval(() => {
    try {
      connection.sendText(heartbeatFrame())
    } catch {}
  }, heartbeatMs)
  heartbeatTimer.unref?.()

  try {
    const sent = connection.sendText(sessionCreateFrame(options.model))
    if (!sent) throw new GrokError('session.create 发送失败（连接未就绪）', 'TRANSPORT')

    while (!finished) {
      const next = await queue.next()
      if (next.done) break
      const item = next.value

      if (item.__abort) throw abortError()
      if (item.__total) {
        if (content.trim()) {
          yield { kind: 'end', reason: 'truncated' }
          finished = true
          return
        }
        throw new GrokError(`grok-web 等待首个正文分块超时（${Math.round(totalTimeoutMs / 1000)}s）`, 'TIMEOUT')
      }
      if (item.__idle) {
        if (content.trim()) {
          yield { kind: 'end', reason: 'idle' }
          finished = true
          return
        }
        continue
      }
      if (item.__closed) {
        if (content.trim()) {
          yield { kind: 'end', reason: 'truncated' }
          finished = true
          return
        }
        const detail = item.__closed.code ? `（code ${item.__closed.code}）` : ''
        throw new GrokError(`grok-web 连接在收到正文前关闭${detail}`, 'TRANSPORT')
      }

      const { message, event } = item
      const type = event.type

      if (type === 'session.created' || type === 'conversation.attached') {
        const nextSessionId =
          message.session_id || event.session_id || event.session?.id || message.session?.id || ''
        if (nextSessionId) sessionId = String(nextSessionId)
        if (type === 'session.created' && sessionId && !sentPrompt) {
          const promptSent = connection.sendText(responseCreateFrame(sessionId, options.prompt))
          if (!promptSent) {
            throw new GrokError('response.create 发送失败（连接已关闭）', 'TRANSPORT')
          }
          sentPrompt = true
          yield { kind: 'ready', sessionId }
        }
        continue
      }

      if (type === 'response.chunk') {
        const chunk = event.chunk || {}
        const text = chunk.text
        if (text && text.channel === RESPONSE_CHANNEL && typeof text.text === 'string' && text.text) {
          content += text.text
          armIdleTimer()
          yield { kind: 'text', text: text.text }
        }
        continue
      }

      if (DONE_EVENTS.has(type)) {
        if (!sentPrompt) continue
        if (!content.trim()) {
          throw new GrokError(
            'Grok 本轮没有返回正文（可能额度用尽、账号受限或登录态失效）；请先在 grok.com 页面确认能正常提问',
            'EMPTY_RESPONSE',
          )
        }
        const responseId = message.response_id || event.response_id || event.response?.id || ''
        yield { kind: 'end', reason: 'stop', ...(responseId ? { responseId: String(responseId) } : {}) }
        finished = true
        return
      }

      if (type === 'response.failed' || type === 'response.error' || type === 'error' || type === 'conversation.error') {
        throw upstreamError(message, seenTypes)
      }
      // 其余事件（ping/response.created/output_item.*/tool_usage_card 等）忽略。
    }
  } finally {
    finished = true
    stopAllTimers()
    signal?.removeEventListener('abort', onAbort)
    connection.off?.('message', onMessage)
    connection.off?.('error', onError)
    connection.off?.('close', onClose)
    try {
      connection.close?.(1000, 'done')
    } catch {}
  }
}

/**
 * 只验证 session.create → session.created（不提问、不消耗生成额度）。
 * 登录脚本和 --status 用它判断登录态是否真的能建会话。
 */
export async function verifyHandshake(options) {
  const auth = options.auth
  if (!auth?.cookieHeader || !auth?.userId) {
    throw new GrokError('缺少 Grok 登录态（cookie / userId）', 'MISSING_CREDENTIAL')
  }
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 20_000)
  const connectTimeoutMs = Math.max(3000, Number(options.connectTimeoutMs) || timeoutMs)
  const connect = options.connect ?? connectWebSocket
  const url = wsUrlWithUid(options.wsUrl || GROK_WS_URL, auth.userId)
  const connection = await connect(url, {
    headers: headersFor(auth),
    proxy: options.proxy || '',
    timeoutMs: connectTimeoutMs,
  })

  return await new Promise((resolve, reject) => {
    let settled = false
    const seenTypes = new Set()
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connection.off?.('message', onMessage)
      connection.off?.('error', onError)
      connection.off?.('close', onClose)
      try {
        connection.close?.(1000, 'verify')
      } catch {}
      if (error) reject(error)
      else resolve(result)
    }
    const onMessage = (text, isBinary) => {
      if (isBinary) return
      let message
      try {
        message = JSON.parse(String(text))
      } catch {
        return
      }
      const event = message?.event || {}
      if (typeof event.type === 'string' && seenTypes.size < MAX_SEEN_TYPES) seenTypes.add(event.type)
      if (event.type === 'session.created') {
        const sessionId = message.session_id || event.session_id || event.session?.id || ''
        finish(null, {
          sessionId: String(sessionId || ''),
          model: options.model || 'fast',
          // 服务端回显的 session（含它实际接受的 model）：排查档位名时要用
          session: event.session ?? message.session ?? null,
          seenTypes: [...seenTypes],
        })
        return
      }
      if (event.type === 'error' || event.type === 'response.failed' || event.type === 'conversation.error') {
        finish(upstreamError(message, seenTypes))
      }
    }
    const onError = (error) => {
      finish(
        error instanceof GrokError
          ? error
          : new GrokError(`grok-web WebSocket 错误：${error?.message ?? error}`, 'TRANSPORT', { cause: error }),
      )
    }
    const onClose = (info) => {
      finish(
        new GrokError(
          `grok-web 连接在 session.created 前关闭${info?.code ? `（code ${info.code}）` : ''}` +
            ` [events=${[...seenTypes].join(',') || 'none'}]`,
          'TRANSPORT',
        ),
      )
    }
    const timer = setTimeout(() => {
      finish(new GrokError(`grok-web 等待 session.created 超时（${Math.round(timeoutMs / 1000)}s）`, 'TIMEOUT'))
    }, timeoutMs)
    timer.unref?.()
    connection.on('message', onMessage)
    connection.on('error', onError)
    connection.on('close', onClose)
    const sent = connection.sendText(sessionCreateFrame(options.model))
    if (!sent) finish(new GrokError('session.create 发送失败（连接未就绪）', 'TRANSPORT'))
  })
}
