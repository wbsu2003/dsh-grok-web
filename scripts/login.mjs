#!/usr/bin/env node
/**
 * 登录捕获 CLI：
 *   node scripts/login.mjs                 # 拉起独立 Chrome/Edge，登录后自动捕获并验证
 *   node scripts/login.mjs --status        # 只检查现有 auth.json 的登录态（零生成额度）
 *   node scripts/login.mjs --cookie "..."  # 手动粘贴 Cookie 头（可选 --user-id）
 */
import { parseArgs } from 'node:util'
import { browserLogin, readAuthStatus, saveCookieAuth } from '../lib/browser-login.js'
import { describeAuth, resolveAuthFile } from '../lib/auth.js'
import { resolveProxy } from '../lib/proxy.js'

const HELP = `用法：node scripts/login.mjs [选项]

默认：拉起独立的 Chrome/Edge profile，等你在窗口里登录 grok.com，
然后通过 CDP 读取 Cookie，并用一次 mgw 握手验证（不提问、不消耗生成额度）。

选项：
  --auth-file <path>     auth.json 位置（默认 %DSH_HOME%\\grok-web\\auth.json）
  --cookie <header>      手动提供 Cookie 头（与 --status / 浏览器模式互斥）
  --user-id <id>         手动模式下补充 x-userid（cookie 里没有时使用）
  --user-agent <ua>      手动模式下的 User-Agent
  --browser <edge|chrome|path>  用哪个浏览器登录（默认 Edge 优先），或直接给可执行文件路径
  --profile <dir>        指定登录用的独立 profile 目录
  --proxy <url|auto|off> Node 侧握手验证使用的代理（默认 auto：环境变量/系统代理）
  --timeout-ms <ms>      等待登录的总时长（默认 600000 = 10 分钟）
  --keep-open            捕获完成后不关闭登录窗口
  --no-verify            跳过 mgw 握手验证（不推荐）
  --status               只检查现有登录态，不上传任何对话内容
  -h, --help             显示帮助
`

function parseCli(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      'auth-file': { type: 'string' },
      cookie: { type: 'string' },
      'user-id': { type: 'string' },
      'user-agent': { type: 'string' },
      browser: { type: 'string' },
      profile: { type: 'string' },
      proxy: { type: 'string' },
      'timeout-ms': { type: 'string' },
      'keep-open': { type: 'boolean', default: false },
      'no-verify': { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values
}

async function main() {
  const values = parseCli(process.argv.slice(2))
  if (values.help) {
    process.stdout.write(HELP)
    return
  }

  const proxyInfo = resolveProxy({ configProxy: values.proxy ?? 'auto', targetUrl: 'wss://grok.com/' })
  const proxy = proxyInfo.url
  const authFile = resolveAuthFile(values['auth-file'])
  const verify = values['no-verify'] !== true
  const common = {
    authFile,
    proxy,
    verify,
    userId: values['user-id'],
    userAgent: values['user-agent'],
  }

  if (values.status) {
    process.stdout.write(`检查登录态：${authFile}\n`)
    process.stdout.write(`代理：${proxy || '直连'}${proxy ? `（${proxyInfo.source}）` : ''}\n`)
    const status = await readAuthStatus({ ...common, cookie: values.cookie })
    const info = describeAuth(status.auth)
    process.stdout.write(`登录态：${JSON.stringify(info, null, 2)}\n`)
    process.stdout.write(`mgw 握手：通过${status.sessionId ? `（session=${status.sessionId}）` : ''}\n`)
    return
  }

  if (values.cookie) {
    process.stdout.write(`手动 Cookie 模式 → ${authFile}\n`)
    const result = await saveCookieAuth({
      ...common,
      cookie: values.cookie,
      verifyAttempts: 3,
    })
    process.stdout.write(`已保存登录态：${result.file}\n`)
    if (result.sessionId) process.stdout.write(`mgw 握手验证通过（session=${result.sessionId}）\n`)
    return
  }

  process.stdout.write(`登录态将保存到：${authFile}\n`)
  process.stdout.write(`握手验证代理：${proxy || '直连'}${proxy ? `（${proxyInfo.source}）` : ''}\n`)
  const preferred = ['edge', 'chrome'].includes(String(values.browser ?? '').trim().toLowerCase())
    ? String(values.browser).trim().toLowerCase()
    : ''
  const result = await browserLogin({
    authFile,
    browserPath: preferred ? undefined : values.browser,
    browser: preferred || undefined,
    profileDir: values.profile,
    proxy,
    timeoutMs: Number(values['timeout-ms']) || 600_000,
    keepOpen: values['keep-open'] === true,
    verify,
    onProgress: (message) => process.stdout.write(`${message}\n`),
  })
  process.stdout.write(`\n已保存登录态：${result.file}${result.browser?.name ? `（来自 ${result.browser.name}）` : ''}\n`)
  if (result.sessionId) process.stdout.write(`mgw 握手验证通过（session=${result.sessionId}）\n`)
  if (!values['keep-open']) process.stdout.write('登录窗口已关闭。\n')
  process.stdout.write('\n下一步：node scripts/probe.mjs "你好"\n')
}

main().catch((error) => {
  const code = error?.code ? `[${error.code}] ` : ''
  process.stderr.write(`\n登录失败：${code}${error?.message ?? error}\n`)
  if (error?.code === 'AUTH') {
    process.stderr.write('提示：请确认浏览器里确实登录了 grok.com，且能正常发消息；登录态过期就重新登录一次。\n')
  } else if (error?.code === 'TRANSPORT' || error?.code === 'TIMEOUT') {
    process.stderr.write('提示：检查代理（--proxy）与网络；Grok 需要能直连或经代理访问。\n')
  }
  process.exitCode = 1
})
