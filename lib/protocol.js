/**
 * 提示词协议层：
 *  1) 把 DSH 的消息词汇（system / user / assistant / tool / developer）序列化成
 *     Grok 网页端能吃的单段 prompt（mgw 只有 input_chunks 文本，没有 tools 字段）。
 *  2) 工具调用桥：Grok 网页端没有原生 function calling，改用
 *     「```dsh-tool + JSON` 协议 + 流式过滤」——命中就转成 tool-call 块，
 *     其余文本原样透传，协议块本身绝不上屏。
 */
import { randomUUID } from 'node:crypto'
import { GrokError } from './errors.js'

const MAX_TOOL_SECTION_CHARS = 48_000
const MAX_CAPTURE_CHARS = 256 * 1024
const CALL_FENCE_NAME = 'dsh-tool'
const FENCE_OPEN_RE = /```[ \t]*dsh-tool(?:[ \t]+[a-zA-Z0-9_-]+)?[ \t]*\r?\n?/i
const BARE_START_RE = /^\s*\{\s*"tool_calls?"\s*:/
const BARE_MARKER = '{"tool_calls"'

export const TOOL_PROTOCOL_INSTRUCTIONS = `# Tool Calling Protocol

You can call tools to complete the user's task. When you need a tool, output a single JSON object inside a fenced code block, with no other text before or after it:

\`\`\`dsh-tool
{"tool_calls":[{"name":"<tool-name>","arguments":{<json-arguments>}}]}
\`\`\`

Rules:
1. Put exactly ONE tool in the "tool_calls" array — one call per message, never a batch.
2. Stop immediately after the closing fence. The runner executes the call and returns the result to you as the next message.
3. Never fabricate, guess, or simulate tool output — always wait for the real result.
4. When no tool is needed, answer normally in plain text and do NOT emit that JSON.
5. "arguments" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, escape backslashes as \\\\ (e.g. "C:\\\\Users\\\\me"); an unescaped single backslash makes the whole object unparsable. Close every brace: the call object and its "arguments" object each need their OWN closing "}" — one missing "}" makes the whole batch unparsable and the call will be discarded.
5b. Two things break the JSON most often — check them before you emit:
   (a) QUOTES INSIDE A VALUE. A shell/PowerShell command very often contains double quotes, e.g. Get-ChildItem "$env:USERPROFILE\\.dsh". Every such inner double quote MUST be escaped as \\" inside the JSON string. An unescaped one ends the string early and discards the whole call.
   (b) LINE BREAKS INSIDE A VALUE. Never put a real line break inside a string; write \\n instead. When a command needs several statements, join them with ";" on ONE line, or use \\n escapes — do not paste them as actual newlines. Prefer single quotes inside commands to reduce escaping.
6. Always wrap the JSON in a \`\`\`dsh-tool fence (see the example above). Do NOT use XML/HTML-like markup instead: no angle-bracket wrapper tags (no <tool_calls>, <invoke>, <parameter>). An unfenced object or any such markup leaks into the visible transcript.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).
8. NEVER reproduce the transcript. Do not restate previous turns, "[Tool Result …]" blocks, tool output, or the current prompt. Emit ONLY the call you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry.
9. Do NOT batch. Emit one call, stop, and wait for its real result before you decide the next step. Needing several tools means several successive messages, one call each.
10. Unlike a batch, a call here MAY build on the previous step's result — read what came back and use it. But never invent a result you have not received.`

export const BATCH_TOOL_PROTOCOL_INSTRUCTIONS = TOOL_PROTOCOL_INSTRUCTIONS
  .replace(
    '1. Put exactly ONE tool in the "tool_calls" array — one call per message, never a batch.',
    '1. Put every tool you want to run in the "tool_calls" array (usually exactly one; a batch of at most 3 is allowed).',
  )
  .replace(
    '2. Stop immediately after the closing fence. The runner executes the call and returns the result to you as the next message.',
    '2. Stop immediately after the closing fence. The runner executes the call(s) and returns the results to you as the next message.',
  )
  .replace(
    '9. Do NOT batch. Emit one call, stop, and wait for its real result before you decide the next step. Needing several tools means several successive messages, one call each.',
    '9. Keep each batch SMALL — at most 3 calls, and prefer exactly 1. If you need more, send them in successive steps. Long payloads are the ones that most often come out malformed.',
  )
  .replace(
    '10. Unlike a batch, a call here MAY build on the previous step\'s result — read what came back and use it. But never invent a result you have not received.',
    '10. Each call must be able to run on its own: no shared shell variables across calls, no dependence on another call in the same batch.',
  )

export function toolProtocolInstructions(serial = true) {
  return serial ? TOOL_PROTOCOL_INSTRUCTIONS : BATCH_TOOL_PROTOCOL_INSTRUCTIONS
}

export function estimateTokens(text) {
  const value = String(text ?? '')
  let cjk = 0
  for (const char of value) {
    const code = char.codePointAt(0)
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    }
  }
  const rest = value.length - cjk
  return Math.max(1, Math.ceil(cjk + rest / 4))
}

function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function asBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

function flattenDescription(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function renderToolLine(tool, mode) {
  const name = String(tool.name ?? '')
  if (mode === 'names') return `- ${name}`
  const description = flattenDescription(tool.description)
  const shown =
    mode === 'no-description' ? '' : truncate(description, mode === 'full' ? Number.MAX_SAFE_INTEGER : mode === 'short' ? 200 : 80)
  const head = `- ${name}${shown ? `: ${shown}` : ''}`
  return `${head}\n  parameters: ${safeJson(tool.parameters)}`
}

function renderToolCatalog(tools, budget) {
  const normalized = (tools ?? []).filter((tool) => tool && typeof tool.name === 'string' && tool.name)
  if (normalized.length === 0) return ''
  const modes = ['full', 'short', 'minimal', 'no-description', 'names']
  for (const mode of modes) {
    const lines = normalized.map((tool) => renderToolLine(tool, mode))
    let section = `\n\n# Available Tools\n\n${lines.join('\n')}`
    if (section.length <= budget) {
      if (mode === 'names') {
        section += '\n\n(Parameter schemas were omitted to fit the prompt budget. Ask the user to confirm arguments before calling these tools.)'
      }
      return section
    }
  }
  const names = normalized.map((tool) => tool.name).join(', ')
  return `\n\n# Available Tools\n\n${names}\n\n(Full tool definitions were omitted to fit the prompt budget. Ask the user to confirm arguments before calling a tool.)`
}

function truncateMiddle(text, maxChars, tailRatio = 0.7) {
  if (text.length <= maxChars) return text
  const RESERVE = 64
  const budget = Math.max(0, maxChars - RESERVE)
  const tail = Math.floor(budget * tailRatio)
  const head = Math.max(0, budget - tail)
  const dropped = text.length - head - tail
  return `${text.slice(0, head)}\n\n...[${dropped} chars omitted]...\n\n${text.slice(text.length - tail)}`
}

function renderAssistant(blocks) {
  const text = flattenText(blocks)
  const calls = (Array.isArray(blocks) ? blocks : []).filter((block) => block?.type === 'tool-call')
  if (calls.length === 0) return text.trim() ? `Assistant: ${text}` : ''
  const payload = {
    tool_calls: calls.map((call) => {
      let args = {}
      try {
        args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments ?? {})
      } catch {
        args = { _raw: String(call.arguments ?? '') }
      }
      return { name: String(call.name ?? ''), arguments: args }
    }),
  }
  const callText = `\`\`\`${CALL_FENCE_NAME}\n${JSON.stringify(payload)}\n\`\`\``
  return text.trim() ? `Assistant: ${text}\n\n${callText}` : `Assistant: ${callText}`
}

function renderToolResult(toolCallId, content, isError) {
  const body = flattenText(content).trim() || '(no output)'
  return `[Tool Result${isError ? ' [ERROR]' : ''} for ${String(toolCallId ?? '')}]\n${body}`
}

function blockMarkers(blocks) {
  const marks = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image') marks.push('[image attached — this route cannot view images]')
    if (block.type === 'file') {
      const name = block.attachment?.name ?? block.name ?? 'file'
      marks.push(`[file attached: ${name}]`)
    }
  }
  return marks
}

function renderDeveloper(blocks, tools) {
  const byName = new Map()
  for (const tool of tools ?? []) {
    if (tool && typeof tool.name === 'string') byName.set(tool.name, tool)
  }
  const lines = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      const text = String(block.text ?? '').trim()
      if (text) lines.push(text)
      continue
    }
    if (block.type !== 'tool-addition' && block.type !== 'tool-removal') continue
    const name = String(block.toolName ?? block.name ?? '').trim()
    if (!name) continue
    if (block.type === 'tool-removal') {
      lines.push(`[Tool removed: ${name}] — it is no longer available, do not call it.`)
      continue
    }
    const tool = byName.get(name)
    const description = flattenDescription(tool?.description)
    lines.push(
      [`[Tool added: ${name}]`, description, tool ? `parameters: ${safeJson(tool.parameters)}` : '']
        .filter(Boolean)
        .join('\n'),
    )
  }
  return lines
}

/**
 * @param {object} options
 * @param {string} [options.system]
 * @param {readonly any[]} options.messages
 * @param {readonly any[]} [options.tools]
 * @param {number} [options.maxChars]
 * @param {boolean} [options.serialToolCalls]
 * @returns {{head: string, transcript: string, full: string, entries: string[]}}
 */
export function serializePromptParts(options) {
  const maxChars = Number(options.maxChars ?? 200_000)
  if (!Number.isSafeInteger(maxChars) || maxChars < 128) {
    throw new RangeError('maxChars 必须是至少 128 的整数')
  }
  const tools = options.tools ?? []
  const systemParts = []
  if (options.system && String(options.system).trim()) systemParts.push(String(options.system).trim())

  const messages = Array.isArray(options.messages) ? options.messages : []
  const rest = []
  let leading = true
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if (leading && message.role === 'system') {
      const text = flattenText(message.content).trim()
      if (text) systemParts.push(text)
      continue
    }
    leading = false
    rest.push(message)
  }

  const system = systemParts.join('\n\n')
  const instructions = tools.length > 0 ? toolProtocolInstructions(options.serialToolCalls !== false) : ''
  const toolBudget = Math.max(
    1_000,
    Math.min(
      MAX_TOOL_SECTION_CHARS,
      Math.floor(maxChars * 0.6) - system.length - instructions.length - 256,
    ),
  )
  const catalog = tools.length > 0 ? renderToolCatalog(tools, toolBudget) : ''
  const protocol = instructions ? `\n\n${instructions}${catalog}` : ''
  const head = `${system}${protocol}`.trim()

  const lines = []
  let pendingToolCallIds = []
  for (const message of rest) {
    const blocks = asBlocks(message.content)
    if (message.role === 'developer') {
      lines.push(...renderDeveloper(blocks, tools))
      pendingToolCallIds = []
      continue
    }
    if (message.role === 'system') {
      const text = flattenText(blocks).trim()
      if (text) lines.push(`[System]\n${text}`)
      continue
    }
    if (message.role === 'assistant') {
      const rendered = renderAssistant(blocks)
      const calls = blocks.filter((block) => block?.type === 'tool-call')
      pendingToolCallIds = calls.map((block) => String(block.id ?? block.toolCallId ?? ''))
      if (rendered) lines.push(rendered)
      continue
    }
    if (message.role === 'tool') {
      lines.push(renderToolResult(message.toolCallId, blocks, message.isError === true))
      pendingToolCallIds = []
      continue
    }

    const toolResults = blocks.filter((block) => block?.type === 'tool-result')
    const text = flattenText(blocks.filter((block) => block?.type !== 'tool-result'))
    const marks = blockMarkers(blocks)
    if (toolResults.length === 0 && pendingToolCallIds.length > 0 && marks.length === 0 && text.trim()) {
      const textBlocks = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())
        .map((block) => block.text)
      const ids = pendingToolCallIds
      pendingToolCallIds = []
      if (textBlocks.length === ids.length && ids.length > 0) {
        for (let index = 0; index < ids.length; index += 1) {
          lines.push(`[Tool Result for ${ids[index]}]\n${textBlocks[index]}`)
        }
      } else {
        lines.push(`[Tool Result for ${ids.filter(Boolean).join(', ')}]\n${text}`)
      }
      continue
    }
    pendingToolCallIds = []
    if (text.trim() || marks.length > 0) {
      lines.push(`User: ${text}${marks.length ? `\n${marks.join(' ')}` : ''}`)
    }
    for (const result of toolResults) {
      lines.push(renderToolResult(result.toolCallId, result.content, result.isError === true))
    }
  }

  const entries = lines.filter((line) => line.trim())
  const transcript = entries.join('\n\n')
  if (!transcript) {
    if (head.length > maxChars) {
      throw new GrokError(
        '系统提示与工具目录超出 prompt 预算，请减少固定输入或调大 maxPromptChars',
        'CONTEXT_WINDOW_EXCEEDED',
      )
    }
    return { head, transcript: '', full: head, entries }
  }
  const separator = '\n\n---\n\n'
  const budget = maxChars - head.length - separator.length
  if (budget < 128) {
    throw new GrokError(
      '系统提示与工具目录超出 prompt 预算，请减少固定输入或调大 maxPromptChars',
      'CONTEXT_WINDOW_EXCEEDED',
    )
  }
  const sentTranscript = truncateMiddle(transcript, budget, 0.7)
  return {
    head,
    transcript: sentTranscript,
    full: head ? `${head}${separator}${sentTranscript}` : sentTranscript,
    entries,
  }
}

export function serializePrompt(options) {
  return serializePromptParts(options).full
}

/** 从 `{`（或 `[`）开始截取配平的 JSON；未配平返回 null。 */
export function extractBalancedJson(text) {
  const value = String(text ?? '')
  let start = -1
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') continue
    if (char !== '{' && char !== '[') return null
    start = index
    break
  }
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return { json: value.slice(start, index + 1), end: index }
      if (depth < 0) return null
    }
  }
  return null
}

function repairJson(raw) {
  return String(raw)
    .replace(/^\uFEFF/, '')
    .replace(/,(\s*[}\]])/g, '$1')
    .trim()
}

function normalizeArguments(value) {
  if (value === undefined || value === null) return { ok: true, json: '{}' }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { ok: true, json: '{}' }
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') return { ok: true, json: JSON.stringify(parsed) }
      return { ok: false }
    } catch {
      return { ok: false }
    }
  }
  if (typeof value === 'object') {
    try {
      JSON.stringify(value)
      return { ok: true, json: JSON.stringify(value) }
    } catch {
      return { ok: false }
    }
  }
  return { ok: false }
}

/** 解析协议载荷 → {ok:true,calls} / {ok:false,reason}。 */
export function parseToolPayload(raw) {
  const text = repairJson(raw)
  if (!text) return { ok: false, reason: 'unparsable' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'unparsable' }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed?.tool_calls ?? parsed?.tool_call)
  const entries = Array.isArray(list) ? list : list && typeof list === 'object' ? [list] : null
  if (!entries) return { ok: false, reason: 'unparsable' }
  const calls = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const name = String(entry.name ?? entry.tool ?? '').trim()
    if (!name || !/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) continue
    const normalized = normalizeArguments(entry.arguments ?? entry.parameters)
    if (!normalized.ok) return { ok: false, reason: 'unparsable' }
    calls.push({
      id: toolCallId(),
      name,
      arguments: normalized.json,
      fenced: true,
    })
  }
  if (calls.length === 0) return { ok: false, reason: 'unparsable' }
  return { ok: true, calls }
}

function emptyOutput() {
  return { text: '', calls: [], fenced: undefined, rejected: undefined }
}

/**
 * 流式过滤器：文本可随时透传，识别到协议块就扣住并转成调用。
 *
 * 只认显式的 ```dsh-tool 围栏（以及输出最开头的裸 {"tool_calls":…} fallback）。
 * 普通 ```json / ```bash 代码块不受影响 —— 这是最容易误伤的地方。
 */
export class ToolCallStreamFilter {
  constructor() {
    this.buffer = ''
    this.anyText = false
    this.inFence = false
    this.rejected = undefined
  }

  push(chunk) {
    if (chunk) this.buffer += String(chunk)
    return this.drain(false)
  }

  flush() {
    return this.drain(true)
  }

  drain(final) {
    let text = ''
    const calls = []
    let fenced

    const emitText = (value) => {
      if (!value) return
      text += value
      if (/\S/.test(value)) this.anyText = true
    }

    while (true) {
      if (this.inFence) {
        const end = this.buffer.indexOf('```')
        if (end < 0) {
          if (this.buffer.length > MAX_CAPTURE_CHARS) {
            this.rejected = { raw: this.buffer.slice(0, 500), mode: 'json', reason: 'oversize' }
            this.buffer = ''
            this.inFence = false
          }
          break
        }
        const raw = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 3)
        this.inFence = false
        const parsed = parseToolPayload(raw)
        if (parsed.ok) {
          calls.push(...parsed.calls)
          fenced = true
        } else {
          this.rejected = { raw, mode: 'json', reason: parsed.reason }
        }
        continue
      }

      const fence = FENCE_OPEN_RE.exec(this.buffer)
      const bareStart = this.anyText ? -1 : this.bareStart()
      if (fence && (bareStart < 0 || fence.index <= bareStart)) {
        emitText(this.buffer.slice(0, fence.index))
        this.buffer = this.buffer.slice(fence.index + fence[0].length)
        this.inFence = true
        continue
      }
      if (bareStart >= 0) {
        const found = extractBalancedJson(this.buffer.slice(bareStart))
        emitText(this.buffer.slice(0, bareStart))
        if (!found) {
          this.buffer = this.buffer.slice(bareStart)
          break
        }
        const raw = found.json
        this.buffer = this.buffer.slice(bareStart + found.end + 1)
        const parsed = parseToolPayload(raw)
        if (parsed.ok) {
          calls.push(...parsed.calls)
          fenced = false
        } else {
          this.rejected = { raw, mode: 'json', reason: parsed.reason }
        }
        continue
      }

      const hold = this.holdbackLength()
      if (hold > 0) {
        emitText(this.buffer.slice(0, this.buffer.length - hold))
        this.buffer = this.buffer.slice(this.buffer.length - hold)
      } else {
        emitText(this.buffer)
        this.buffer = ''
      }
      break
    }

    if (final) {
      if (this.inFence) {
        const raw = this.buffer
        this.buffer = ''
        this.inFence = false
        const parsed = parseToolPayload(raw)
        if (parsed.ok) {
          calls.push(...parsed.calls)
          fenced = true
        } else if (raw.trim()) {
          this.rejected = { raw, mode: 'json', reason: 'unbalanced' }
        }
      } else if (this.buffer) {
        const bareStart = this.anyText ? -1 : this.bareStart()
        if (bareStart >= 0) {
          const found = extractBalancedJson(this.buffer.slice(bareStart))
          if (found) {
            const raw = found.json
            emitText(this.buffer.slice(0, bareStart))
            this.buffer = this.buffer.slice(bareStart + found.end + 1)
            emitText(this.buffer)
            const parsed = parseToolPayload(raw)
            if (parsed.ok) {
              calls.push(...parsed.calls)
              fenced = false
            } else {
              this.rejected = { raw, mode: 'json', reason: 'unparsable' }
            }
          } else {
            this.rejected = { raw: this.buffer.slice(bareStart), mode: 'json', reason: 'unbalanced' }
            emitText(this.buffer.slice(0, bareStart))
          }
        } else {
          emitText(this.buffer)
        }
        this.buffer = ''
      }
      for (const call of calls) call.fenced = fenced === true
      return { text, calls, fenced, rejected: this.rejected }
    }

    for (const call of calls) call.fenced = fenced === true
    return { text, calls, fenced, rejected: this.rejected }
  }

  bareStart() {
    if (!this.buffer.startsWith('{') && !/^\s+\{/.test(this.buffer)) return -1
    const leading = /^\s*/.exec(this.buffer)[0].length
    const rest = this.buffer.slice(leading)
    if (!BARE_START_RE.test(rest)) return -1
    return leading
  }

  holdbackLength() {
    let hold = 0
    const tail = /(`{1,3})([a-zA-Z0-9_-]*)$/.exec(this.buffer)
    if (tail) {
      const ticks = tail[1]
      const word = tail[2]
      if (ticks.length === 2) hold = Math.max(hold, 2)
      else if (ticks.length === 3 && (word === '' || 'dsh-tool'.startsWith(word))) {
        hold = Math.max(hold, ticks.length + word.length)
      }
    }
    if (!this.anyText) {
      const leading = /^\s*/.exec(this.buffer)[0].length
      const rest = this.buffer.slice(leading)
      if (rest.startsWith('{')) {
        const compact = rest.replace(/\s+/g, '').slice(0, BARE_MARKER.length)
        if (BARE_MARKER.startsWith(compact)) hold = this.buffer.length
      }
    }
    return hold
  }
}

export function toolCallId() {
  return `call_${randomUUID()}`
}
