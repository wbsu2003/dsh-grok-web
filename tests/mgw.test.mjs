import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { heartbeatFrame, responseCreateFrame, sessionCreateFrame, streamMgw, verifyHandshake } from '../lib/mgw.js'

const AUTH = {
  cookieHeader: 'x-userid=user-1; sso=secret',
  userId: 'user-1',
  userAgent: 'test-ua',
}

class FakeConnection extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.closed = false
    this.closeInfo = null
  }

  sendText(text) {
    this.sent.push(JSON.parse(text))
    return true
  }

  close(code, reason) {
    this.closed = true
    this.closeInfo = { code: code ?? 1000, reason: reason ?? '' }
    this.emit('close', this.closeInfo)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, label = 'condition', timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`等待超时：${label}`)
}

function startStream(options = {}) {
  const fake = new FakeConnection()
  const state = { fake, events: [], error: null, done: false, connectOptions: null }
  state.run = (async () => {
    try {
      for await (const event of streamMgw({
        auth: AUTH,
        prompt: 'hello',
        idleTimeoutMs: 1_000,
        totalTimeoutMs: 10_000,
        heartbeatMs: 60_000,
        connect: async (url, connectOptions) => {
          state.connectOptions = { url, ...connectOptions }
          return fake
        },
        ...options,
      })) {
        state.events.push(event)
      }
    } catch (error) {
      state.error = error
    }
    state.done = true
  })()
  return state
}

async function establish(state, sessionId = 'session-1') {
  await waitFor(() => state.fake.sent.length === 1, 'session.create')
  state.fake.emit('message', JSON.stringify({ session_id: sessionId, event: { type: 'session.created' } }), false)
  await waitFor(() => state.fake.sent.length === 2, 'response.create')
}

test('sessionCreateFrame / responseCreateFrame / heartbeatFrame 形状正确', () => {
  const session = JSON.parse(sessionCreateFrame('fast'))
  assert.equal(session.event.type, 'session.create')
  assert.equal(session.event.session.model, 'fast')
  assert.equal(session.event.session.x_grok.is_temporary, true)
  assert.equal(session.event.session.x_grok.use_chunk, true)
  assert.ok(session.event.session.x_grok.protocol_capabilities.includes('custom_methods_v1'))
  assert.ok(session.event.event_id)

  const response = JSON.parse(responseCreateFrame('s1', 'hi'))
  assert.equal(response.session_id, 's1')
  assert.equal(response.event.type, 'response.create')
  assert.equal(response.event.item.x_grok.input_chunks[0].text.text, 'hi')

  const heartbeat = JSON.parse(heartbeatFrame())
  assert.equal(heartbeat.event.type, 'ping')
  assert.ok(heartbeat.event.event_id)
})

test('streamMgw: 完整会话只收助手正文，done 结束', async () => {
  const state = startStream()
  await establish(state)

  assert.ok(state.connectOptions.url.includes('wss://grok.com/ws/mgw/'))
  assert.ok(state.connectOptions.url.includes('uid=user-1'))
  assert.equal(state.connectOptions.headers.Cookie, AUTH.cookieHeader)
  assert.equal(state.connectOptions.headers['User-Agent'], AUTH.userAgent)

  assert.equal(state.fake.sent[1].session_id, 'session-1')
  assert.equal(state.fake.sent[1].event.item.x_grok.input_chunks[0].text.text, 'hello')

  state.fake.emit(
    'message',
    JSON.stringify({ event: { type: 'response.chunk', chunk: { text: { channel: 'CHANNEL_THINKING', text: '不要' } } } }),
    false,
  )
  state.fake.emit(
    'message',
    JSON.stringify({ event: { type: 'response.chunk', chunk: { text: { channel: 'CHANNEL_ASSISTANT_RESPONSE', text: '你' } } } }),
    false,
  )
  state.fake.emit(
    'message',
    JSON.stringify({ event: { type: 'response.chunk', chunk: { text: { channel: 'CHANNEL_ASSISTANT_RESPONSE', text: '好' } } } }),
    false,
  )
  state.fake.emit('message', JSON.stringify({ response_id: 'resp-1', event: { type: 'response.done' } }), false)
  await state.run

  assert.equal(state.error, null)
  assert.deepEqual(
    state.events.filter((event) => event.kind === 'text').map((event) => event.text),
    ['你', '好'],
  )
  assert.deepEqual(state.events.find((event) => event.kind === 'ready'), { kind: 'ready', sessionId: 'session-1' })
  const end = state.events.find((event) => event.kind === 'end')
  assert.equal(end.reason, 'stop')
  assert.equal(end.responseId, 'resp-1')
  assert.equal(state.fake.closed, true)
})

test('streamMgw: 只有思考通道、收到 done 时报 EMPTY_RESPONSE', async () => {
  const state = startStream()
  await establish(state)
  state.fake.emit(
    'message',
    JSON.stringify({ event: { type: 'response.chunk', chunk: { text: { channel: 'CHANNEL_THINKING', text: '想了很久' } } } }),
    false,
  )
  state.fake.emit('message', JSON.stringify({ event: { type: 'response.done' } }), false)
  await state.run
  assert.equal(state.error?.code, 'EMPTY_RESPONSE')
})

test('streamMgw: 上游鉴权错误映射为 AUTH', async () => {
  const state = startStream()
  await establish(state)
  state.fake.emit(
    'message',
    JSON.stringify({ event: { type: 'response.failed' }, error: { code: 'unauthenticated', message: 'login required' } }),
    false,
  )
  await state.run
  assert.equal(state.error?.code, 'AUTH')
  assert.match(state.error.message, /login required/)
})

test('streamMgw: 上下文超限映射为 CONTEXT_WINDOW_EXCEEDED', async () => {
  const state = startStream()
  await establish(state)
  state.fake.emit(
    'message',
    JSON.stringify({ event: { type: 'error' }, error: { code: 'bad_request', message: 'maximum context length exceeded' } }),
    false,
  )
  await state.run
  assert.equal(state.error?.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('streamMgw: 正文前连接关闭映射为 TRANSPORT', async () => {
  const state = startStream()
  await establish(state)
  state.fake.emit('close', { code: 1006, reason: 'socket closed' })
  await state.run
  assert.equal(state.error?.code, 'TRANSPORT')
  assert.match(state.error.message, /1006/)
})

test('streamMgw: 有正文后静默达到 idle 阈值按完成结束', async (t) => {
  // 生产代码的定时器全部 unref，FakeConnection 又不是真实句柄；
  // 这里需要一个 ref'd 定时器，否则测试运行器会在等待 idle 期间认为事件循环已结束。
  const keepAlive = setInterval(() => {}, 50)
  t.after(() => clearInterval(keepAlive))
  const state = startStream()
  await establish(state)
  state.fake.emit(
    'message',
    JSON.stringify({ event: { type: 'response.chunk', chunk: { text: { channel: 'CHANNEL_ASSISTANT_RESPONSE', text: '一段回答' } } } }),
    false,
  )
  await state.run
  assert.equal(state.error, null)
  const end = state.events.find((event) => event.kind === 'end')
  assert.equal(end?.reason, 'idle')
})

test('streamMgw: 缺少登录态直接报 MISSING_CREDENTIAL', async () => {
  await assert.rejects(
    streamMgw({ auth: {}, prompt: 'hi' }).next(),
    (error) => error.code === 'MISSING_CREDENTIAL',
  )
  await assert.rejects(
    streamMgw({ auth: { cookieHeader: 'a=b' }, prompt: 'hi' }).next(),
    (error) => error.code === 'MISSING_CREDENTIAL',
  )
})

test('verifyHandshake: 只发 session.create，拿到 session_id 即通过', async () => {
  const fake = new FakeConnection()
  const pending = verifyHandshake({
    auth: AUTH,
    timeoutMs: 5_000,
    connect: async () => fake,
  })
  await waitFor(() => fake.sent.length === 1, 'session.create')
  assert.equal(fake.sent[0].event.type, 'session.create')
  fake.emit('message', JSON.stringify({ session_id: 'verify-1', event: { type: 'session.created' } }), false)
  const result = await pending
  assert.equal(result.sessionId, 'verify-1')
  assert.equal(fake.closed, true)
})

test('verifyHandshake: 上游拒绝时映射错误码', async () => {
  const fake = new FakeConnection()
  const pending = verifyHandshake({ auth: AUTH, timeoutMs: 5_000, connect: async () => fake })
  await waitFor(() => fake.sent.length === 1, 'session.create')
  fake.emit(
    'message',
    JSON.stringify({ event: { type: 'error' }, error: { code: 'forbidden', message: 'invalid token' } }),
    false,
  )
  await assert.rejects(pending, (error) => error.code === 'AUTH')
})
