/**
 * 最小 RFC6455 WebSocket 客户端（Node 原生 net/tls）。
 *
 * 为什么不用 `ws` 包 / 全局 WebSocket：
 *   · 全局 WebSocket 无法把「代理 CONNECT + 握手失败的 HTTP 状态码」暴露出来
 *     （实测只得到 "non-101 status code"，无法区分 401 还是 Cloudflare 拦截）；
 *   · `ws` 会引入运行时依赖，而 DSH 插件的装配目录未必能解析到它。
 * 这里只实现用得到的部分：文本/二进制消息、分片、ping/pong、close、HTTP CONNECT 代理。
 */
import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import { GrokError, httpErrorCode, parseRetryAfterMs } from './errors.js'
import { proxyParts } from './proxy.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_HEADER_BYTES = 64 * 1024
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

function targetOf(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new GrokError(`WebSocket URL 不合法：${url}`, 'PROTOCOL')
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new GrokError(`WebSocket URL 必须是 ws:// 或 wss://，收到 ${parsed.protocol}`, 'PROTOCOL')
  }
  const secure = parsed.protocol === 'wss:'
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80
  const hostForHeader = parsed.host
  const path = `${parsed.pathname || '/'}${parsed.search || ''}`
  return { secure, host, port, hostForHeader, path }
}

function hostPort(host, port) {
  return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`
}

function remaining(deadline) {
  const ms = deadline - Date.now()
  if (ms <= 0) throw new GrokError('连接 Grok 超时', 'TIMEOUT')
  return ms
}

function waitEvent(emitter, events, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      for (const event of events) emitter.off(event, onEvent)
      emitter.off('error', onError)
    }
    const onEvent = (value) => {
      cleanup()
      resolve(value)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    timer = setTimeout(() => {
      cleanup()
      reject(onTimeout())
    }, timeoutMs)
    for (const event of events) emitter.once(event, onEvent)
    emitter.once('error', onError)
  })
}

function connectTcp(host, port, timeoutMs) {
  const socket = net.connect({ host, port })
  socket.setNoDelay(true)
  return waitEvent(socket, ['connect'], timeoutMs, () =>
    new GrokError(`连接 ${hostPort(host, port)} 超时`, 'TIMEOUT'),
  ).then(() => socket)
}

function wrapTls(socket, host, timeoutMs) {
  const options = {
    socket,
    servername: net.isIP(host) ? undefined : host,
    minVersion: 'TLSv1.2',
    ALPNProtocols: ['http/1.1'],
  }
  const secure = tls.connect(options)
  secure.setNoDelay(true)
  return waitEvent(secure, ['secureConnect'], timeoutMs, () =>
    new GrokError(`TLS 握手超时（${host}）`, 'TIMEOUT'),
  ).then(() => secure)
}

function readHttpHead(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.pause()
    }
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end >= 0) {
        cleanup()
        resolve({
          head: buffer.subarray(0, end).toString('latin1'),
          rest: buffer.subarray(end + 4),
        })
        return
      }
      if (buffer.length > MAX_HEADER_BYTES) {
        cleanup()
        reject(new GrokError('HTTP 响应头超过 64KB', 'PROTOCOL'))
      }
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new GrokError('连接在 HTTP 响应头完成前关闭', 'TRANSPORT'))
    }
    timer = setTimeout(() => {
      cleanup()
      reject(new GrokError('等待 HTTP 响应头超时', 'TIMEOUT'))
    }, timeoutMs)
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.resume()
  })
}

function headerValue(head, name) {
  const matched = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(head)
  return matched ? matched[1].trim() : ''
}

function handshakeFailure(status, head) {
  const code = httpErrorCode(status)
  const ray = headerValue(head, 'cf-ray')
  const retryAfter = parseRetryAfterMs(headerValue(head, 'retry-after'))
  const hints = {
    AUTH: 'Grok 登录态无效或已过期，请重新运行 scripts/login.mjs',
    RATE_LIMIT: 'Grok 限流，请稍后重试',
    SERVER: 'Grok 服务端错误，请稍后重试',
    QUOTA: 'Grok 账号额度不足',
  }
  const detail = hints[code] ? `：${hints[code]}` : ''
  const suffix = `${ray ? ` [cf-ray=${ray}]` : ''}`
  return new GrokError(`WebSocket 握手被拒绝（HTTP ${status}）${detail}${suffix}`, code, {
    status,
    ...(retryAfter !== undefined ? { providerRetryAfterMs: retryAfter } : {}),
  })
}

async function openTransport(target, proxyUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const proxy = proxyParts(proxyUrl)
  if (!proxy) {
    let socket
    if (target.secure) {
      socket = tls.connect({
        host: target.host,
        port: target.port,
        servername: net.isIP(target.host) ? undefined : target.host,
        minVersion: 'TLSv1.2',
        ALPNProtocols: ['http/1.1'],
      })
      socket.setNoDelay(true)
      await waitEvent(socket, ['secureConnect'], remaining(deadline), () =>
        new GrokError(`TLS 握手超时（${target.host}）`, 'TIMEOUT'),
      )
    } else {
      socket = await connectTcp(target.host, target.port, remaining(deadline))
    }
    return socket
  }

  let socket = await connectTcp(proxy.host, proxy.port, remaining(deadline))
  if (proxy.secure) {
    socket = await wrapTls(socket, proxy.host, remaining(deadline))
  }

  const authority = hostPort(target.host, target.port)
  const connectHead = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    'Proxy-Connection: keep-alive',
    ...(proxy.authorization ? [`Proxy-Authorization: ${proxy.authorization}`] : []),
    '',
    '',
  ].join('\r\n')
  socket.write(connectHead)
  const { head, rest } = await readHttpHead(socket, remaining(deadline))
  const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/i.exec(head)?.[1] ?? 0)
  if (status !== 200) {
    socket.destroy()
    if (status === 407) {
      throw new GrokError(`代理要求认证（HTTP 407）：${proxy.host}:${proxy.port}`, 'TRANSPORT', { status })
    }
    throw new GrokError(`代理 CONNECT 失败（HTTP ${status || '?'}）：${proxy.host}:${proxy.port}`, 'TRANSPORT', {
      ...(status ? { status } : {}),
    })
  }
  // CONNECT 200 之后理论上没有遗留字节；若有，说明代理行为异常，直接丢弃。
  if (rest.length > 0) rest.length = 0

  if (target.secure) {
    socket.resume()
    return wrapTls(socket, target.host, remaining(deadline))
  }
  socket.resume()
  return socket
}

export function encodeFrame(payload, { opcode = 0x1, fin = true, mask = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const first = (fin ? 0x80 : 0) | (opcode & 0x0f)
  let header
  if (body.length < 126) {
    header = Buffer.from([first, (mask ? 0x80 : 0) | body.length])
  } else if (body.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = first
    header[1] = (mask ? 0x80 : 0) | 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = first
    header[1] = (mask ? 0x80 : 0) | 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  if (!mask) return Buffer.concat([header, body])
  const maskKey = randomBytes(4)
  const masked = Buffer.alloc(body.length)
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ maskKey[index & 3]
  }
  return Buffer.concat([header, maskKey, masked])
}

function tryParseFrame(buffer) {
  if (buffer.length < 2) return null
  const first = buffer[0]
  const second = buffer[1]
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(MAX_MESSAGE_BYTES)) {
      throw new GrokError(`WebSocket 帧过大（${big} 字节）`, 'PROTOCOL')
    }
    length = Number(big)
    offset = 10
  }
  let maskKey = null
  if (masked) {
    if (buffer.length < offset + 4) return null
    maskKey = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (length > MAX_MESSAGE_BYTES) {
    throw new GrokError(`WebSocket 帧过大（${length} 字节）`, 'PROTOCOL')
  }
  if (buffer.length < offset + length) return null
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (maskKey) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index & 3]
  }
  return { fin, opcode, payload, bytes: offset + length }
}

export class WsConnection extends EventEmitter {
  constructor(socket) {
    super()
    this.socket = socket
    this.readyState = 1
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
    this.closeEmitted = false
    this.closeInfo = null
    this.onData = (chunk) => this.feed(chunk)
    this.onSocketError = (error) => {
      // 关闭后的 socket 仍可能抛 TLS alert/RST 之类的错误；此时没有消费者了，
      // 必须保持一个监听者把它吞掉，否则会成为未处理的 'error' 崩掉进程。
      if (this.readyState === 3) return
      if (this.listenerCount('error') > 0) this.emit('error', error)
    }
    this.onSocketClose = () => this.emitClose({ code: 1006, reason: 'socket closed', wasClean: false })
    socket.on('data', this.onData)
    socket.on('error', this.onSocketError)
    socket.once('close', this.onSocketClose)
    socket.resume()
  }

  feed(chunk) {
    if (this.readyState === 3) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    try {
      for (;;) {
        const frame = tryParseFrame(this.buffer)
        if (!frame) return
        this.buffer = this.buffer.subarray(frame.bytes)
        this.handleFrame(frame)
        if (this.readyState === 3) return
      }
    } catch (error) {
      this.fail(error)
    }
  }

  handleFrame(frame) {
    if (frame.opcode === 0x9) {
      this.sendFrame(0xa, frame.payload)
      return
    }
    if (frame.opcode === 0xa) return
    if (frame.opcode === 0x8) {
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005
      const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : ''
      this.sendFrame(0x8, frame.payload)
      this.socket.end()
      this.emitClose({ code, reason, wasClean: true })
      return
    }
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (this.fragments.length > 0) {
        this.fail(new GrokError('WebSocket 分片顺序错乱', 'PROTOCOL'))
        return
      }
      if (frame.fin) {
        this.emitMessage(frame.opcode, frame.payload)
      } else {
        this.fragmentOpcode = frame.opcode
        this.fragments.push(frame.payload)
      }
      return
    }
    if (frame.opcode === 0x0) {
      if (this.fragments.length === 0) {
        this.fail(new GrokError('收到无法归属的 WebSocket 续帧', 'PROTOCOL'))
        return
      }
      this.fragments.push(frame.payload)
      if (frame.fin) {
        const payload = Buffer.concat(this.fragments)
        const opcode = this.fragmentOpcode
        this.fragments = []
        this.fragmentOpcode = 0
        this.emitMessage(opcode, payload)
      }
    }
  }

  emitMessage(opcode, payload) {
    if (opcode === 0x1) {
      this.emit('message', payload.toString('utf8'), false)
    } else {
      this.emit('message', payload, true)
    }
  }

  sendFrame(opcode, payload) {
    if (this.readyState !== 1 || !this.socket.writable) return false
    try {
      this.socket.write(encodeFrame(payload, { opcode, mask: true }))
      return true
    } catch {
      return false
    }
  }

  sendText(text) {
    return this.sendFrame(0x1, Buffer.from(String(text), 'utf8'))
  }

  ping(payload = Buffer.alloc(0)) {
    return this.sendFrame(0x9, payload)
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return
    const reasonBuffer = Buffer.from(reason, 'utf8')
    const payload = Buffer.alloc(2 + reasonBuffer.length)
    payload.writeUInt16BE(code, 0)
    reasonBuffer.copy(payload, 2)
    this.sendFrame(0x8, payload)
    this.readyState = 2
    this.socket.end()
    const timer = setTimeout(() => this.socket.destroy(), 1000)
    timer.unref?.()
    this.readyState = 3
    this.emitClose({ code, reason, wasClean: true })
  }

  terminate(error) {
    if (error && this.listenerCount('error') > 0) this.emit('error', error)
    this.readyState = 3
    this.socket.destroy()
    this.emitClose({ code: 1006, reason: error ? String(error.message ?? error) : 'terminated', wasClean: false })
  }

  emitClose(info) {
    if (this.closeEmitted) return
    this.closeEmitted = true
    this.readyState = 3
    this.socket.off('data', this.onData)
    // 保留 onSocketError：它会在 readyState=3 时静默吞掉收尾阶段的错误。
    this.socket.off('close', this.onSocketClose)
    this.emit('close', info)
  }

  fail(error) {
    this.terminate(error instanceof Error ? error : new GrokError(String(error), 'PROTOCOL'))
  }
}

/**
 * 建立 WebSocket 连接并完成握手。
 * @param {string} url
 * @param {object} [options]
 * @param {Record<string,string>} [options.headers]
 * @param {string} [options.proxy] - http(s) 代理 URL；空串表示直连
 * @param {number} [options.timeoutMs]
 * @returns {Promise<WsConnection>}
 */
export async function connectWebSocket(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 20_000
  const target = targetOf(url)
  const deadline = Date.now() + timeoutMs
  const socket = await openTransport(target, options.proxy || '', timeoutMs)
  try {
    socket.setNoDelay?.(true)
    const key = randomBytes(16).toString('base64')
    const headers = {
      Host: target.hostForHeader,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...(options.headers || {}),
    }
    const lines = [`GET ${target.path} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || value === null || value === '') continue
      lines.push(`${name}: ${value}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)

    const { head, rest } = await readHttpHead(socket, remaining(deadline))
    const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/i.exec(head)?.[1] ?? 0)
    if (status !== 101) throw handshakeFailure(status, head)
    if (!/^websocket$/i.test(headerValue(head, 'upgrade'))) {
      throw new GrokError('WebSocket 握手响应缺少 Upgrade: websocket', 'PROTOCOL')
    }
    const expected = createHash('sha1').update(key + WS_GUID).digest('base64')
    const accept = headerValue(head, 'sec-websocket-accept')
    if (accept !== expected) {
      throw new GrokError('WebSocket 握手校验失败（Sec-WebSocket-Accept 不匹配）', 'PROTOCOL')
    }

    const connection = new WsConnection(socket)
    if (rest.length > 0) connection.feed(rest)
    return connection
  } catch (error) {
    socket.destroy()
    throw error
  }
}
