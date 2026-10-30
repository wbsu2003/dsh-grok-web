/**
 * 极简 Chrome DevTools Protocol 客户端（WebSocket 上的 JSON-RPC）。
 * 只用于登录捕获：Storage.getCookies / Browser.getVersion / Browser.close。
 */
import { GrokError } from './errors.js'
import { connectWebSocket } from './ws.js'

export async function connectCdp(wsUrl, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 15_000
  const ws = await connectWebSocket(wsUrl, { timeoutMs })
  let nextId = 1
  const pending = new Map()
  const listeners = new Set()

  const failAll = (error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      pending.delete(id)
    }
  }

  ws.on('message', (text, isBinary) => {
    if (isBinary) return
    let message
    try {
      message = JSON.parse(String(text))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(new GrokError(`CDP ${entry.method} 失败：${message.error.message ?? 'unknown'}`, 'PROTOCOL'))
      } else {
        entry.resolve(message.result)
      }
      return
    }
    for (const listener of listeners) {
      try {
        listener(message)
      } catch {}
    }
  })
  ws.on('close', () => failAll(new GrokError('浏览器 CDP 连接已关闭', 'TRANSPORT')))
  ws.on('error', (error) => {
    failAll(error instanceof Error ? error : new GrokError(String(error), 'TRANSPORT'))
  })

  return {
    send(method, params = {}, sessionId) {
      const id = nextId
      nextId += 1
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new GrokError(`CDP ${method} 超时`, 'TIMEOUT'))
        }, timeoutMs)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer, method })
        if (!ws.sendText(JSON.stringify(payload))) {
          pending.delete(id)
          clearTimeout(timer)
          reject(new GrokError(`CDP ${method} 发送失败（连接已关闭）`, 'TRANSPORT'))
        }
      })
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      try {
        ws.close(1000, 'cdp done')
      } catch {}
    },
  }
}
