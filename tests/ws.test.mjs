import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import net from 'node:net'
import { connectWebSocket, encodeFrame, WsConnection } from '../lib/ws.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function decodeFrame(buffer) {
  const first = buffer[0]
  const second = buffer[1]
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const masked = (second & 0x80) !== 0
  let mask = null
  if (masked) {
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3]
  }
  return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, masked, payload }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.written = []
    this.writable = true
    this.ended = false
    this.destroyed = false
    this.paused = false
  }

  write(buffer) {
    this.written.push(Buffer.from(buffer))
    return true
  }

  end() {
    this.ended = true
  }

  destroy() {
    this.destroyed = true
  }

  pause() {
    this.paused = true
  }

  resume() {
    this.paused = false
  }

  setNoDelay() {}
}

test('encodeFrame: 短帧、扩展长度、掩码与不掩码', () => {
  const plain = decodeFrame(encodeFrame('hi', { mask: false }))
  assert.equal(plain.fin, true)
  assert.equal(plain.opcode, 0x1)
  assert.equal(plain.masked, false)
  assert.equal(plain.payload.toString(), 'hi')

  const masked = decodeFrame(encodeFrame('hello', { mask: true }))
  assert.equal(masked.masked, true)
  assert.equal(masked.payload.toString(), 'hello')

  const medium = decodeFrame(encodeFrame('x'.repeat(200), { mask: false }))
  assert.equal(medium.payload.length, 200)

  const large = decodeFrame(encodeFrame('y'.repeat(70_000), { mask: false }))
  assert.equal(large.payload.length, 70_000)
  assert.equal(large.payload.toString(), 'y'.repeat(70_000))

  const closeFrame = decodeFrame(encodeFrame(Buffer.from([0x03, 0xe8]), { opcode: 0x8, mask: false }))
  assert.equal(closeFrame.opcode, 0x8)
})

test('WsConnection: 文本消息、分片消息、跨 data 事件的半截帧', () => {
  const socket = new FakeSocket()
  const connection = new WsConnection(socket)
  const messages = []
  connection.on('message', (text, isBinary) => messages.push({ text, isBinary }))

  socket.emit('data', encodeFrame('one', { mask: false }))

  const fragmented = Buffer.concat([
    encodeFrame('hel', { opcode: 0x1, fin: false, mask: false }),
    encodeFrame('lo', { opcode: 0x0, fin: true, mask: false }),
  ])
  socket.emit('data', fragmented.subarray(0, 3))
  socket.emit('data', fragmented.subarray(3))

  const binary = Buffer.from([0x00, 0xff, 0x10])
  socket.emit('data', encodeFrame(binary, { opcode: 0x2, mask: false }))

  assert.deepEqual(messages.map((entry) => entry.text), ['one', 'hello', binary])
  assert.equal(messages[2].isBinary, true)
})

test('WsConnection: 收到 ping 自动回 pong', () => {
  const socket = new FakeSocket()
  const connection = new WsConnection(socket)
  socket.emit('data', encodeFrame('ping-payload', { opcode: 0x9, mask: false }))
  assert.equal(socket.written.length, 1)
  const pong = decodeFrame(socket.written[0])
  assert.equal(pong.opcode, 0xa)
  assert.equal(pong.masked, true)
  assert.equal(pong.payload.toString(), 'ping-payload')
})

test('WsConnection: 收到 close 帧后回 close 并发出 close 事件', () => {
  const socket = new FakeSocket()
  const connection = new WsConnection(socket)
  const closes = []
  connection.on('close', (info) => closes.push(info))

  const payload = Buffer.alloc(2 + 3)
  payload.writeUInt16BE(1000, 0)
  payload.write('bye', 2)
  socket.emit('data', encodeFrame(payload, { opcode: 0x8, mask: false }))

  assert.equal(closes.length, 1)
  assert.equal(closes[0].code, 1000)
  assert.equal(closes[0].reason, 'bye')
  assert.equal(closes[0].wasClean, true)
  assert.equal(socket.ended, true)
  assert.equal(connection.readyState, 3)
})

test('WsConnection: 主动 close 发送 close 帧并结束连接', () => {
  const socket = new FakeSocket()
  const connection = new WsConnection(socket)
  const closes = []
  connection.on('close', (info) => closes.push(info))
  connection.close(1000, 'done')

  assert.equal(closes.length, 1)
  assert.equal(closes[0].code, 1000)
  assert.equal(socket.ended, true)
  const frame = decodeFrame(socket.written[0])
  assert.equal(frame.opcode, 0x8)
  assert.equal(frame.payload.readUInt16BE(0), 1000)
})

test('WsConnection: 关闭后到达的 socket 错误被吞掉', () => {
  const socket = new FakeSocket()
  const connection = new WsConnection(socket)
  connection.close(1000, 'done')
  assert.doesNotThrow(() => socket.emit('error', new Error('late TLS error')))
  assert.equal(connection.readyState, 3)
})

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function closeServer(t, server) {
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  )
}

test('connectWebSocket: 完成真实握手并收到服务端帧', async (t) => {
  const server = net.createServer((socket) => {
    let buffer = ''
    let upgraded = false
    socket.on('data', (chunk) => {
      if (upgraded) return
      buffer += chunk.toString('latin1')
      if (!buffer.includes('\r\n\r\n')) return
      upgraded = true
      const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(buffer)[1]
      const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n'),
      )
      setTimeout(() => socket.write(encodeFrame('hello-from-server', { mask: false })), 30)
    })
  })
  const port = await listen(server)
  closeServer(t, server)

  const connection = await connectWebSocket(`ws://127.0.0.1:${port}/ws?uid=42`)
  const message = await new Promise((resolve, reject) => {
    connection.once('message', (text) => resolve(text))
    connection.once('error', reject)
  })
  assert.equal(message, 'hello-from-server')
  connection.close()
})

test('connectWebSocket: 401 映射为 AUTH 并带 cf-ray 与状态码', async (t) => {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncf-ray: test-ray\r\nContent-Length: 0\r\n\r\n')
    })
  })
  const port = await listen(server)
  closeServer(t, server)

  await assert.rejects(
    connectWebSocket(`ws://127.0.0.1:${port}/ws`),
    (error) => {
      assert.equal(error.code, 'AUTH')
      assert.equal(error.failure.code, 'AUTH')
      assert.equal(error.failure.status, 401)
      assert.match(error.message, /cf-ray=test-ray/)
      return true
    },
  )
})

test('connectWebSocket: 429 映射为 RATE_LIMIT 并解析 Retry-After', async (t) => {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nContent-Length: 0\r\n\r\n')
    })
  })
  const port = await listen(server)
  closeServer(t, server)

  await assert.rejects(
    connectWebSocket(`ws://127.0.0.1:${port}/ws`),
    (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      assert.equal(error.failure.providerRetryAfterMs, 2_000)
      return true
    },
  )
})

test('connectWebSocket: 非法 URL 直接报 PROTOCOL', async () => {
  await assert.rejects(connectWebSocket('http://grok.com/'), (error) => error.code === 'PROTOCOL')
})
