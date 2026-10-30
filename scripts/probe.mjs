#!/usr/bin/env node
/**
 * 端到端探针（不经过 DSH）：读 auth.json → mgw 直连 → 打印流式正文。
 *
 *   node scripts/probe.mjs "你好"
 *   node scripts/probe.mjs --prompt "用一句话介绍你自己" --json
 *   node scripts/probe.mjs --status          # 只做握手验证
 */
import { parseArgs } from 'node:util'
import { readAuth } from '../lib/auth.js'
import { resolveProxy } from '../lib/proxy.js'
import { streamMgw, verifyHandshake } from '../lib/mgw.js'
import { normalizeConfig } from '../lib/config.js'

const HELP = `用法：node scripts/probe.mjs [prompt] [选项]

选项：
  --prompt <text>    要发送的内容（默认：用一句话介绍你自己。）
  --auth-file <path> auth.json（默认 %DSH_HOME%\\grok-web\\auth.json）
  --cookie <header>  直接给 Cookie 头
  --model <name>     mgw 服务端模型名（默认 fast）
  --proxy <url|auto|off>  代理（默认 auto：环境变量/系统代理）
  --timeout-ms <ms>  总超时（默认 300000）
  --idle-ms <ms>     正文静默完成阈值（默认 15000）
  --status           只验证 session.create → session.created
  --json             以 NDJSON 输出事件
  -h, --help         显示帮助
`

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    prompt: { type: 'string' },
    'auth-file': { type: 'string' },
    cookie: { type: 'string' },
    model: { type: 'string' },
    proxy: { type: 'string' },
    'timeout-ms': { type: 'string' },
    'idle-ms': { type: 'string' },
    status: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const prompt = values.prompt ?? positionals[0] ?? '用一句话介绍你自己。'
const config = normalizeConfig({
  authFile: values['auth-file'],
  cookie: values.cookie,
  model: values.model,
  proxy: values.proxy ?? 'auto',
  totalTimeoutMs: Number(values['timeout-ms']) || undefined,
  idleTimeoutMs: Number(values['idle-ms']) || undefined,
})

async function main() {
  const proxyInfo = resolveProxy({ configProxy: config.proxy, targetUrl: 'wss://grok.com/' })
  const auth = readAuth(config)

  if (!values.json) {
    process.stdout.write(`provider=grok-web model=${config.model} proxy=${proxyInfo.url || '直连'}（${proxyInfo.source}）\n`)
  }

  if (values.status) {
    const verified = await verifyHandshake({
      auth,
      model: config.model,
      proxy: proxyInfo.url,
      timeoutMs: 20_000,
    })
    process.stdout.write(`握手通过：session=${verified.sessionId || '(未返回)'} model=${verified.model}\n`)
    return
  }

  const startedAt = Date.now()
  let chars = 0
  let end
  for await (const event of streamMgw({
    auth,
    prompt,
    model: config.model,
    proxy: proxyInfo.url,
    idleTimeoutMs: config.idleTimeoutMs,
    totalTimeoutMs: config.totalTimeoutMs,
    heartbeatMs: config.heartbeatMs,
    connectTimeoutMs: config.connectTimeoutMs,
    debug: true,
    logger: {
      info: (message) => {
        if (values.json) return
        process.stderr.write(`[debug] ${message}\n`)
      },
    },
  })) {
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ at: Date.now() - startedAt, ...event })}\n`)
    }
    if (event.kind === 'ready') {
      if (!values.json) process.stderr.write(`[session] ${event.sessionId}\n`)
    } else if (event.kind === 'text') {
      chars += event.text.length
      process.stdout.write(event.text)
    } else if (event.kind === 'end') {
      end = event
    }
  }
  if (!values.json) {
    process.stdout.write(
      `\n\n---\n完成：${chars} 字，${Date.now() - startedAt}ms，结束=${end?.reason ?? 'unknown'}\n`,
    )
  }
}

main().catch((error) => {
  const code = error?.code ? `[${error.code}] ` : ''
  process.stderr.write(`\n探针失败：${code}${error?.message ?? error}\n`)
  if (error?.code === 'AUTH') process.stderr.write('提示：重新运行 node scripts/login.mjs。\n')
  if (error?.code === 'TRANSPORT') process.stderr.write('提示：检查代理是否可用（--proxy off 可直连试试）。\n')
  process.exitCode = 1
})
