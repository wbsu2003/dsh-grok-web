import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractBalancedJson,
  parseToolPayload,
  serializePromptParts,
  ToolCallStreamFilter,
  estimateTokens,
  toolProtocolInstructions,
} from '../lib/protocol.js'

const TOOL_READ = {
  name: 'read',
  description: 'Read a text file from disk',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
}

const FENCED_READ = '```dsh-tool\n{"tool_calls":[{"name":"read","arguments":{"file_path":"a.txt"}}]}\n```'

test('serializePromptParts: 固定头含 system、工具协议与目录，历史含各类消息', () => {
  const parts = serializePromptParts({
    system: 'You are DSH.',
    messages: [
      { role: 'user', content: '你好' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我来看看' },
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"file_path":"a.txt"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] },
      { role: 'assistant', content: [{ type: 'text', text: '完成了' }] },
    ],
    tools: [TOOL_READ],
    maxChars: 200_000,
  })

  assert.ok(parts.head.startsWith('You are DSH.'))
  assert.ok(parts.head.includes('# Tool Calling Protocol'))
  assert.ok(parts.head.includes('# Available Tools'))
  assert.ok(parts.head.includes('- read: Read a text file from disk'))
  assert.ok(parts.head.includes('"file_path"'))

  assert.ok(parts.transcript.includes('User: 你好'))
  assert.ok(parts.transcript.includes('Assistant: 我来看看'))
  assert.ok(parts.transcript.includes('```dsh-tool'))
  assert.ok(parts.transcript.includes('"name":"read"'))
  assert.ok(parts.transcript.includes('[Tool Result for call_1]\nfile body'))
  assert.ok(parts.transcript.includes('Assistant: 完成了'))
  assert.ok(parts.full.startsWith(parts.head))
  assert.ok(parts.full.includes('\n\n---\n\n'))
})

test('serializePromptParts: 开头的 system 消息并入固定头，中途 system 留在历史', () => {
  const parts = serializePromptParts({
    messages: [
      { role: 'system', content: 'leading system' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'mid system' },
    ],
    maxChars: 100_000,
  })
  assert.ok(parts.head.includes('leading system'))
  assert.ok(!parts.transcript.includes('leading system'))
  assert.ok(parts.transcript.includes('[System]\nmid system'))
  assert.ok(!parts.head.includes('mid system'))
})

test('serializePromptParts: 工具调用后紧跟的 user 文本按工具返回渲染（DSH 的一种真实形状）', () => {
  const parts = serializePromptParts({
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'text', text: 'result body' }] },
    ],
    maxChars: 100_000,
  })
  assert.ok(parts.transcript.includes('[Tool Result for c1]\nresult body'))
  assert.ok(!parts.transcript.includes('User: result body'))
})

test('serializePromptParts: 普通 user 文本不会被误判成工具返回', () => {
  const parts = serializePromptParts({
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '前面没有调用' }] },
      { role: 'user', content: '普通追问' },
    ],
    maxChars: 100_000,
  })
  assert.ok(parts.transcript.includes('User: 普通追问'))
  assert.ok(!parts.transcript.includes('[Tool Result'))
})

test('serializePromptParts: developer 的工具增删块进入历史', () => {
  const parts = serializePromptParts({
    messages: [
      {
        role: 'developer',
        content: [
          { type: 'text', text: 'note from developer' },
          { type: 'tool-addition', toolName: 'read' },
          { type: 'tool-removal', toolName: 'write' },
        ],
      },
    ],
    tools: [TOOL_READ],
    maxChars: 100_000,
  })
  assert.ok(parts.transcript.includes('note from developer'))
  assert.ok(parts.transcript.includes('[Tool added: read]'))
  assert.ok(parts.transcript.includes('Read a text file from disk'))
  assert.ok(parts.transcript.includes('[Tool removed: write]'))
})

test('serializePromptParts: 无工具时不注入工具协议', () => {
  const parts = serializePromptParts({ messages: [{ role: 'user', content: 'hi' }], maxChars: 100_000 })
  assert.ok(!parts.head.includes('# Tool Calling Protocol'))
  assert.ok(!parts.head.includes('# Available Tools'))
  assert.equal(parts.head, '')
})

test('serializePromptParts: 超长历史截断中段但完整保留固定头', () => {
  const parts = serializePromptParts({
    system: 'SYSTEM-HEAD',
    messages: [{ role: 'user', content: `BEGIN-${'A'.repeat(20_000)}-END` }],
    maxChars: 2_000,
  })
  assert.ok(parts.head.includes('SYSTEM-HEAD'))
  assert.ok(parts.transcript.includes('chars omitted'))
  assert.ok(parts.transcript.includes('BEGIN-'))
  assert.ok(parts.transcript.includes('-END'))
  assert.ok(parts.full.length <= 2_000, `full=${parts.full.length}`)
})

test('serializePromptParts: 固定头本身超预算时明确报错', () => {
  assert.throws(
    () => serializePromptParts({ system: 'x'.repeat(5_000), maxChars: 200 }),
    (error) => error.code === 'CONTEXT_WINDOW_EXCEEDED',
  )
})

test('serializePromptParts: 图片与文件只留标记（本路由不支持图片）', () => {
  const parts = serializePromptParts({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这个' },
          { type: 'image', attachment: { id: 'img1' } },
          { type: 'file', attachment: { name: 'notes.txt' } },
        ],
      },
    ],
    maxChars: 100_000,
  })
  assert.ok(parts.transcript.includes('User: 看看这个'))
  assert.ok(parts.transcript.includes('this route cannot view images'))
  assert.ok(parts.transcript.includes('[file attached: notes.txt]'))
})

test('serializePromptParts: serialToolCalls=false 使用批量协议文案', () => {
  const serial = serializePromptParts({ messages: [], tools: [TOOL_READ], maxChars: 100_000, serialToolCalls: true })
  const batch = serializePromptParts({ messages: [], tools: [TOOL_READ], maxChars: 100_000, serialToolCalls: false })
  assert.ok(serial.head.includes('one call per message'))
  assert.ok(batch.head.includes('at most 3 calls'))
  assert.notEqual(toolProtocolInstructions(true), toolProtocolInstructions(false))
})

test('estimateTokens: 中文按字、英文按四字符', () => {
  assert.equal(estimateTokens('你好'), 2)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens(''), 1)
})

test('extractBalancedJson: 识别嵌套对象与字符串里的括号', () => {
  assert.deepEqual(extractBalancedJson('  {"a":{"b":"}"},"c":1} yy'), {
    json: '{"a":{"b":"}"},"c":1}',
    end: 22,
  })
  assert.equal(extractBalancedJson('{"a":1'), null)
  assert.equal(extractBalancedJson('no json'), null)
})

test('parseToolPayload: 对象 / 数组 / 单调用 / 字符串参数 / 尾逗号', () => {
  const object = parseToolPayload('{"tool_calls":[{"name":"read","arguments":{"file_path":"a"}}]}')
  assert.equal(object.ok, true)
  assert.equal(object.calls.length, 1)
  assert.equal(object.calls[0].name, 'read')
  assert.deepEqual(JSON.parse(object.calls[0].arguments), { file_path: 'a' })

  const stringArgs = parseToolPayload('{"tool_calls":[{"name":"read","arguments":"{\\"a\\":1}"}]}')
  assert.equal(stringArgs.ok, true)
  assert.deepEqual(JSON.parse(stringArgs.calls[0].arguments), { a: 1 })

  const single = parseToolPayload('{"tool_call":{"name":"write","parameters":{"x":1}}}')
  assert.equal(single.ok, true)
  assert.equal(single.calls[0].name, 'write')

  const array = parseToolPayload('[{"name":"a","arguments":{}},{"name":"b","arguments":{}}]')
  assert.equal(array.ok, true)
  assert.equal(array.calls.length, 2)

  const trailing = parseToolPayload('{"tool_calls":[{"name":"read","arguments":{"a":1},}]}')
  assert.equal(trailing.ok, true)
})

test('parseToolPayload: 坏名字 / 坏参数 / 空调用都算不可解析', () => {
  assert.equal(parseToolPayload('{"tool_calls":[{"name":"bad name","arguments":{}}]}').ok, false)
  assert.equal(parseToolPayload('{"tool_calls":[{"name":"read","arguments":"not json"}]}').ok, false)
  assert.equal(parseToolPayload('{"tool_calls":[]}').ok, false)
  assert.equal(parseToolPayload('not json').ok, false)
})

test('ToolCallStreamFilter: 普通文本原样透传', () => {
  const filter = new ToolCallStreamFilter()
  const output = filter.push('hello world')
  assert.equal(output.text, 'hello world')
  assert.deepEqual(output.calls, [])
  assert.equal(filter.flush().text, '')
})

test('ToolCallStreamFilter: 普通代码块不受影响', () => {
  const source = '看这段：\n```json\n{"a":1}\n```\n结束'
  const filter = new ToolCallStreamFilter()
  const output = filter.push(source)
  assert.equal(output.text, source)
  assert.deepEqual(output.calls, [])
  assert.equal(filter.flush().text, '')
})

test('ToolCallStreamFilter: 跨分块的围栏调用被捕获，前后正文不丢', () => {
  const filter = new ToolCallStreamFilter()
  const first = filter.push('处理中\n```dsh-')
  assert.equal(first.text, '处理中\n')
  assert.deepEqual(first.calls, [])

  const second = filter.push('tool\n{"tool_calls":[{"name":"read","arguments":{"file_path":"a.txt"}}]}\n```')
  assert.equal(second.text, '')
  assert.equal(second.calls.length, 1)
  assert.equal(second.calls[0].name, 'read')
  assert.equal(second.calls[0].fenced, true)
  assert.deepEqual(JSON.parse(second.calls[0].arguments), { file_path: 'a.txt' })
  assert.match(second.calls[0].id, /^call_/)

  const tail = filter.push('\n收尾')
  assert.equal(tail.text, '\n收尾')
  assert.equal(filter.flush().text, '')
})

test('ToolCallStreamFilter: 调用 JSON 半截分块也能配平', () => {
  const filter = new ToolCallStreamFilter()
  assert.equal(filter.push('```dsh-tool\n{"tool_calls":[{"name":"read",').text, '')
  const output = filter.push('"arguments":{"x":1}}]}\n```')
  assert.equal(output.calls.length, 1)
  assert.deepEqual(JSON.parse(output.calls[0].arguments), { x: 1 })
})

test('ToolCallStreamFilter: 开头的裸 JSON 调用也能识别', () => {
  const filter = new ToolCallStreamFilter()
  const output = filter.push('  {"tool_calls":[{"name":"read","arguments":{"a":1}}]}')
  assert.equal(output.text, '  ')
  assert.equal(output.calls.length, 1)
  assert.equal(output.calls[0].fenced, false)
  assert.deepEqual(JSON.parse(output.calls[0].arguments), { a: 1 })
  assert.deepEqual(filter.flush().calls, [])
})

test('ToolCallStreamFilter: 坏掉的围栏调用被拒绝且不会当正文上屏', () => {
  const filter = new ToolCallStreamFilter()
  assert.equal(filter.push('前缀\n```dsh-tool\n{"tool_calls":[{"name":"read",').text, '前缀\n')
  const output = filter.flush()
  assert.equal(output.text, '')
  assert.deepEqual(output.calls, [])
  assert.ok(output.rejected)
  assert.equal(output.rejected.reason, 'unbalanced')
})

test('ToolCallStreamFilter: 围栏里 JSON 语法错误按不可解析上报', () => {
  const filter = new ToolCallStreamFilter()
  filter.push('```dsh-tool\n{"tool_calls": not-json}\n```')
  const output = filter.flush()
  assert.deepEqual(output.calls, [])
  assert.equal(output.rejected.reason, 'unparsable')
})

test('ToolCallStreamFilter: XML 风格标记不作为调用，按正文透传', () => {
  const source = '模型可能写 <tool_calls><invoke name="read"></invoke></tool_calls> 这种'
  const filter = new ToolCallStreamFilter()
  assert.equal(filter.push(source).text, source)
  assert.equal(filter.flush().text, '')
})

test('ToolCallStreamFilter: 连续两个围栏调用都能收集', () => {
  const filter = new ToolCallStreamFilter()
  const source = `${FENCED_READ}\n中间说明\n${FENCED_READ}`
  const output = filter.push(source)
  assert.equal(output.calls.length, 2)
  assert.equal(output.text.includes('中间说明'), true)
  filter.flush()
})
