#!/usr/bin/env node
/**
 * 档位探针（只握手，不提问，不消耗生成额度）：把候选模型名逐个发给 mgw，
 * 看服务端是接受、报错，还是**静默回落到 fast** —— 决定插件能暴露几档之前必须先量这个。
 *
 *   node scripts/models.mjs
 *   node scripts/models.mjs --models fast,expert,auto,build,heavy
 *   node scripts/models.mjs --proxy off
 */
import { parseArgs } from 'node:util'
import { readAuth } from '../lib/auth.js'
import { resolveProxy } from '../lib/proxy.js'
import { verifyHandshake } from '../lib/mgw.js'
import { normalizeConfig } from '../lib/config.js'

const DEFAULT_CANDIDATES = ['fast', 'expert', 'auto', 'build', 'heavy', 'grok-3', 'zzz-not-a-model']

const HELP = `用法：node scripts/models.mjs [选项]

选项：
  --models <a,b,c>   候选档位名（默认 ${DEFAULT_CANDIDATES.join(',')}）
  --auth-file <path> auth.json（默认 %DSH_HOME%\\grok-web\\auth.json）
  --cookie <header>  直接给 Cookie 头
  --proxy <url|auto|off>  代理（默认 auto）
  --timeout-ms <ms>  单次握手超时（默认 15000）
  --delay-ms <ms>    两次请求之间的间隔（默认 1500）
  -h, --help         显示帮助
`

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    models: { type: 'string' },
    'auth-file': { type: 'string' },
    cookie: { type: 'string' },
    proxy: { type: 'string' },
    'timeout-ms': { type: 'string' },
    'delay-ms': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const candidates = (values.models ?? DEFAULT_CANDIDATES.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)
const config = normalizeConfig({ authFile: values['auth-file'], cookie: values.cookie, proxy: values.proxy ?? 'auto' })
const timeoutMs = Number(values['timeout-ms']) || 15_000
const delayMs = Math.max(200, Number(values['delay-ms']) || 1500)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function echoOf(session) {
  if (!session || typeof session !== 'object') return '(服务端没回显 session)'
  const model = session.model ?? session?.x_grok?.model ?? '(回显里没有 model)'
  const keys = Object.keys(session).join(',')
  return `model=${JSON.stringify(model)} keys=${keys}`
}

const out = (line) => process.stdout.write(`${line}\n`)

async function main() {
  const proxyInfo = resolveProxy({ configProxy: config.proxy, targetUrl: 'wss://grok.com/' })
  const auth = readAuth(config)
  out(`出口代理=${proxyInfo.url || '直连'}（${proxyInfo.source}） 候选=${candidates.length} 个  只握手不提问`)
  for (const [index, model] of candidates.entries()) {
    if (index) await sleep(delayMs)
    const startedAt = Date.now()
    try {
      const verified = await verifyHandshake({ auth, model, proxy: proxyInfo.url, timeoutMs })
      out(`${model.padEnd(18)} 接受  ${echoOf(verified.session)}  ${Date.now() - startedAt}ms`)
    } catch (error) {
      const code = error?.code ? `[${error.code}] ` : ''
      const message = String(error?.message ?? error).split('\n')[0].slice(0, 160)
      out(`${model.padEnd(18)} 拒绝  ${code}${message}  ${Date.now() - startedAt}ms`)
    }
  }
  out('\n判读：对照组 zzz-not-a-model 若也「接受」，说明服务端在建会话阶段不校验档位名，\n' +
      '      那就要看回显的 model 是否被改写；只有对照被拒时，「接受/拒绝」两列才等于档位真伪。')
}

main().catch((error) => {
  const code = error?.code ? `[${error.code}] ` : ''
  process.stderr.write(`探针失败：${code}${error?.message ?? error}\n`)
  process.exitCode = 1
})
