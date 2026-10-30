import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter, RETRY_POLICY } from '../lib/adapter.js'
import { GrokError } from '../lib/errors.js'

const AUTH = {
  cookieHeader: 'x-userid=u1; sso=secret',
  userId: 'u1',
  userAgent: 'UA-test',
  source: 'file',
  expiredCookies: [],
}

const TOOL_READ = {
  name: 'read',
  description: 'Read a text file',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
}

const silentLogger = { info() {}, warn() {}, debug() {} }

function makeAdapter(events, context = {}) {
  const captured = []
  const adapter = createAdapter({
    config: { proxy: false, debug: false, ...(context.config ?? {}) },
    logger: context.logger ?? silentLogger,
    readAuth: context.readAuth ?? (() => AUTH),
    runMgw: async function* (options) {
      captured.push(options)
      if (context.error) throw context.error
      for (const event of events) yield event
    },
  })
  return { adapter, captured }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('adapter 契约: providerInfo / retryPolicy / imageRequestPricing / models', async () => {
  const { adapter } = makeAdapter([])
  assert.deepEqual(adapter.providerInfo(), { id: 'grok-web', name: 'Grok 网页版（免费）' })

  const policy = adapter.providerRetryPolicy()
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 2)
  assert.equal(policy.maxDelayMs, 65_000)
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    assert.ok(policy.retryableCodes.includes(code), code)
  }
  assert.ok(!policy.retryableCodes.includes('AUTH'))
  assert.equal(adapter.imageRequestPricing(), undefined)

  const models = await adapter.listModels('grok-web')
  assert.deepEqual(
    models.map((model) => model.id),
    ['grok-web', 'grok-web-auto', 'grok-web-build'],
  )
  assert.ok(models.every((model) => model.provider === 'grok-web'))
  assert.ok(models.every((model) => model.inputModalities.includes('text')))
  assert.ok(models[0].name.includes('Fast'))

  const resolved = await adapter.resolveModel('grok-web', 'grok-web-auto')
  assert.equal(resolved.id, 'grok-web-auto')
  assert.equal(resolved.context.contextWindow, 131_072)
  assert.equal(resolved.defaultMaxTokens, 16_384)

  const prepared = await adapter.prepareCall('grok-web', 'grok-web')
  assert.equal(prepared.model.id, 'grok-web')
  assert.equal(typeof prepared.stream, 'function')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(adapter.prepareCall('grok-web', 'grok-web', controller.signal), (error) => error.code === 'ABORTED')
})

test('档位路由: prepareCall 选定的档必须真的传到 mgw，未知 id 回落默认档', async () => {
  const { adapter, captured } = makeAdapter([{ kind: 'ready', sessionId: 's1' }, { kind: 'end', reason: 'stop' }])
  const prepared = await adapter.prepareCall('grok-web', 'grok-web-build')
  await collect(prepared.stream({ messages: [{ role: 'user', content: '在' }] }))
  assert.equal(captured.length, 1)
  assert.equal(captured[0].model, 'build')

  await collect(adapter.stream({ model: 'grok-web-auto', messages: [] }))
  assert.equal(captured[1].model, 'auto')

  await collect(adapter.stream({ model: 'grok-web-nope', messages: [] }))
  assert.equal(captured[2].model, 'fast', '未知 id 用配置里的默认档')

  const byServerName = await adapter.resolveModel('grok-web', 'auto')
  assert.equal(byServerName.id, 'grok-web-auto', '服务端档位名也能解析')
})

test('未实测档位的空响应要说清是档位问题，不是登录失效', async () => {
  const empty = new GrokError('Grok 本轮没有返回正文（可能额度用尽、账号受限或登录态失效）', 'EMPTY_RESPONSE')
  const locked = makeAdapter([], { config: { model: 'expert' }, error: empty })
  await assert.rejects(
    collect(locked.adapter.stream({ model: 'grok-web-expert', messages: [] })),
    (error) => {
      assert.equal(error.code, 'EMPTY_RESPONSE', 'code 不变，重试策略照旧')
      assert.ok(error.message.includes('本档 expert 未实测'), error.message)
      assert.ok(error.message.includes('付费档'), error.message)
      return true
    },
  )

  const verified = makeAdapter([], { error: empty })
  await assert.rejects(
    collect(verified.adapter.stream({ messages: [] })),
    (error) => {
      assert.ok(!error.message.includes('未实测'), '实测过的 fast 不该被扣上档位问题')
      return true
    },
  )
})

test('档位路由: 配置里的 model 决定默认档，未实测的档位名也能手工指定', async () => {
  const { adapter, captured } = makeAdapter([{ kind: 'ready', sessionId: 's1' }, { kind: 'end', reason: 'stop' }], {
    config: { model: 'expert' },
  })
  const models = await adapter.listModels('grok-web')
  assert.ok(models.some((model) => model.id === 'grok-web-expert'), '显式配置的档位要出现在列表里')

  await collect(adapter.stream({ messages: [] }))
  assert.equal(captured[0].model, 'expert')
})

test('stream: 纯文本按 StreamChunk 顺序输出，usage 在 finish 前', async () => {
  const { adapter, captured } = makeAdapter([
    { kind: 'ready', sessionId: 's1' },
    { kind: 'text', text: '你好' },
    { kind: 'text', text: '世界' },
    { kind: 'end', reason: 'stop' },
  ])
  const chunks = await collect(
    adapter.stream({ system: 'SYS', messages: [{ role: 'user', content: '问' }], tools: [TOOL_READ] }),
  )

  assert.equal(captured.length, 1)
  assert.equal(captured[0].proxy, '')
  assert.ok(captured[0].prompt.includes('SYS'))
  assert.ok(captured[0].prompt.includes('User: 问'))
  assert.ok(captured[0].prompt.includes('# Available Tools'))

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  )
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: '你好' })
  assert.deepEqual(chunks[3].block, { type: 'text', text: '你好世界' })
  const usage = chunks[4].usage
  assert.ok(usage.inputTokens > 0)
  assert.ok(usage.outputTokens > 0)
  assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens)
  assert.deepEqual(chunks[5], { type: 'finish', reason: { kind: 'stop' } })
})

test('stream: 围栏工具调用转成 tool-call 块，正文块先关闭', async () => {
  const { adapter } = makeAdapter([
    { kind: 'ready', sessionId: 's1' },
    { kind: 'text', text: '处理中\n```dsh-tool\n{"tool_calls":[{"name":"read","arguments":' },
    { kind: 'text', text: '{"file_path":"a.txt"}}]}\n```' },
    { kind: 'end', reason: 'stop' },
  ])
  const chunks = await collect(adapter.stream({ messages: [{ role: 'user', content: '读文件' }], tools: [TOOL_READ] }))

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'block-end', 'block-start', 'tool-call-delta', 'block-end', 'usage', 'finish'],
  )
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(chunks[2].block, { type: 'text', text: '处理中\n' })
  assert.deepEqual(chunks[3], { type: 'block-start', index: 1, blockType: 'tool-call' })

  const delta = chunks[4]
  assert.match(delta.id, /^call_/)
  assert.equal(delta.name, 'read')
  assert.deepEqual(JSON.parse(delta.argumentsDelta), { file_path: 'a.txt' })

  const block = chunks[5].block
  assert.equal(block.type, 'tool-call')
  assert.equal(block.id, delta.id)
  assert.equal(block.name, 'read')
  assert.deepEqual(JSON.parse(block.arguments), { file_path: 'a.txt' })

  assert.deepEqual(chunks[7], { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('stream: 调用之后的正文会重新开一个 text 块', async () => {
  const { adapter } = makeAdapter([
    { kind: 'text', text: '```dsh-tool\n{"tool_calls":[{"name":"read","arguments":{}}]}\n```' },
    { kind: 'text', text: '之后' },
    { kind: 'end', reason: 'stop' },
  ])
  const chunks = await collect(adapter.stream({ messages: [], tools: [TOOL_READ] }))
  const textStart = chunks.findIndex((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text')
  const textEnd = chunks.findIndex((chunk) => chunk.type === 'block-end' && chunk.index === chunks[textStart].index)
  assert.ok(textStart > 0, 'text 块应在工具块之后重新打开')
  assert.ok(textEnd > textStart)
  assert.equal(chunks[textEnd].block.text, '之后')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('stream: 无正文无调用报 EMPTY_RESPONSE', async () => {
  const { adapter } = makeAdapter([{ kind: 'ready' }, { kind: 'end', reason: 'stop' }])
  const chunks = await collect(adapter.stream({ messages: [] }))
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['usage', 'finish'])
  assert.equal(chunks[1].reason.kind, 'error')
  assert.equal(chunks[1].reason.failure.code, 'EMPTY_RESPONSE')
})

test('stream: 截断按 max-tokens 上报', async () => {
  const { adapter } = makeAdapter([
    { kind: 'text', text: '写到一半' },
    { kind: 'end', reason: 'truncated' },
  ])
  const chunks = await collect(adapter.stream({ messages: [] }))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('stream: 坏掉的调用被丢弃，并按可重试错误上报', async () => {
  const { adapter } = makeAdapter([
    { kind: 'text', text: '```dsh-tool\n{"tool_calls":[{"name":"read",' },
    { kind: 'end', reason: 'stop' },
  ])
  const chunks = await collect(adapter.stream({ messages: [] }))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
  assert.match(chunks.at(-1).reason.failure.message, /调用格式无法解析/)
  assert.ok(!chunks.some((chunk) => chunk.type === 'text-delta'))
})

test('stream: 上游异常归一化为 TRANSPORT', async () => {
  const { adapter } = makeAdapter([], { error: new Error('socket exploded') })
  await assert.rejects(
    collect(adapter.stream({ messages: [] })),
    (error) => error.code === 'TRANSPORT' && error.name === 'LlmError',
  )
})

test('stream: 缺少登录态的 GrokError 原样抛出', async () => {
  const { adapter } = makeAdapter([], {
    readAuth: () => {
      throw new GrokError('no auth', 'MISSING_CREDENTIAL')
    },
  })
  await assert.rejects(collect(adapter.stream({ messages: [] })), (error) => error.code === 'MISSING_CREDENTIAL')
})

test('stream: 开始前已取消报 ABORTED', async () => {
  const { adapter } = makeAdapter([{ kind: 'text', text: '不应出现' }])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    collect(adapter.stream({ signal: controller.signal, messages: [] })),
    (error) => error.code === 'ABORTED',
  )
})

test('stream: 流中途取消报 ABORTED', async () => {
  const controller = new AbortController()
  const adapter = createAdapter({
    config: { proxy: false },
    logger: silentLogger,
    readAuth: () => AUTH,
    runMgw: async function* () {
      yield { kind: 'text', text: '半截' }
      await new Promise((resolve) => setTimeout(resolve, 20))
    },
  })
  const running = collect(adapter.stream({ signal: controller.signal, messages: [] }))
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(running, (error) => error.code === 'ABORTED')
})

test('stream: 标题 / 压缩用途不发送工具目录', async () => {
  const { adapter, captured } = makeAdapter([
    { kind: 'text', text: '标题' },
    { kind: 'end', reason: 'stop' },
  ])
  await collect(
    adapter.stream({
      purpose: 'session-title',
      messages: [{ role: 'user', content: '给这段对话起标题' }],
      tools: [TOOL_READ],
    }),
  )
  assert.ok(!captured[0].prompt.includes('# Tool Calling Protocol'))
  assert.ok(!captured[0].prompt.includes('# Available Tools'))
  assert.ok(captured[0].prompt.includes('给这段对话起标题'))
})

test('stream: serialToolCalls=false 时使用批量协议', async () => {
  const { adapter, captured } = makeAdapter(
    [{ kind: 'text', text: 'ok' }, { kind: 'end', reason: 'stop' }],
    { config: { serialToolCalls: false } },
  )
  await collect(adapter.stream({ messages: [{ role: 'user', content: 'hi' }], tools: [TOOL_READ] }))
  assert.ok(captured[0].prompt.includes('at most 3 calls'))
})

test('RETRY_POLICY 是扁平对象且码表锁定', () => {
  assert.equal(RETRY_POLICY.mode, 'normal')
  assert.ok(Object.isFrozen(RETRY_POLICY.retryableCodes))
  assert.equal(typeof RETRY_POLICY.initialDelayMs, 'number')
  assert.equal(typeof RETRY_POLICY.jitterRatio, 'number')
})
