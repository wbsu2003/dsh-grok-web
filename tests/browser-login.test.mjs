import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserLogin, captureLoginCookies, detectLoginWall, openExternalLogin, readPageHint } from '../lib/browser-login.js'
import { EventEmitter } from 'node:events'

test('browserLogin: 附加模式端口不可达时报 TRANSPORT，且不需要本机浏览器路径', async () => {
  // 127.0.0.1:1 不会有 CDP；这里只验证「附加模式不启动进程、失败即返回」
  const progress = []
  await assert.rejects(
    () => browserLogin({ cdpPort: 1, profileDir: '.', onProgress: (message) => progress.push(String(message)) }),
    (error) => {
      assert.equal(error.code, 'TRANSPORT')
      assert.ok(error.message.includes('调试端口 1'), error.message)
      return true
    },
  )
  assert.ok(!progress.some((line) => line.includes('启动')), '附加模式不应启动新浏览器')
})

test('detectLoginWall: 认出网页端的风控文案，认不出正常登录页', () => {
  assert.ok(detectLoginWall('很抱歉，你的账户已被临时限制。'))
  assert.ok(detectLoginWall("This account is temporarily limited."))
  assert.ok(detectLoginWall('Too many sign-in attempts. Try again later.'))
  assert.ok(detectLoginWall('登录尝试过多，请稍后再试'))
  assert.equal(detectLoginWall('Sign in with QR code · Username or email'), null)
  assert.equal(detectLoginWall(''), null)
  assert.equal(detectLoginWall(undefined), null)
})

function fakeCdp(responses) {
  const calls = []
  return {
    calls,
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId })
      const handler = responses[method]
      if (!handler) return {}
      return typeof handler === 'function' ? handler(params, sessionId) : handler
    },
  }
}

test('readPageHint: 优先读认证/核验页而不是 grok.com 主标签，并带上来源域名', async () => {
  const cdp = fakeCdp({
    'Target.getTargets': {
      targetInfos: [
        { type: 'page', targetId: 'T-grok', url: 'https://grok.com/' },
        { type: 'page', targetId: 'T-x', url: 'https://x.com/i/jf/onboarding/web?mode=login#/s/knowledge_check/r-1' },
        { type: 'service_worker', targetId: 'T-sw', url: 'https://grok.com/sw.js' },
      ],
    },
    'Target.attachToTarget': { sessionId: 'S-x' },
    'Runtime.evaluate': { result: { value: '登录\n\n 确认你的帐户 用户名 继续 ' } },
    'Target.detachFromTarget': {},
  })
  const hint = await readPageHint(cdp)
  assert.equal(hint, 'x.com：登录 确认你的帐户 用户名 继续')
  const evaluate = cdp.calls.find((call) => call.method === 'Runtime.evaluate')
  assert.equal(evaluate.sessionId, 'S-x')
  assert.equal(cdp.calls.find((call) => call.method === 'Target.attachToTarget').params.targetId, 'T-x')
  assert.ok(cdp.calls.some((call) => call.method === 'Target.detachFromTarget'), '必须 detach，否则会话泄漏')
})

test('readPageHint: 没有认证页时退回 grok.com，再没有就空串', async () => {
  const cdp = fakeCdp({
    'Target.getTargets': {
      targetInfos: [
        { type: 'page', targetId: 'T-other', url: 'https://example.com/' },
        { type: 'page', targetId: 'T-grok', url: 'https://grok.com/chat' },
      ],
    },
    'Target.attachToTarget': { sessionId: 'S-grok' },
    'Runtime.evaluate': { result: { value: 'Imagine 登录 注册' } },
    'Target.detachFromTarget': {},
  })
  assert.equal(await readPageHint(cdp), 'grok.com：Imagine 登录 注册')
  assert.equal(cdp.calls.find((call) => call.method === 'Target.attachToTarget').params.targetId, 'T-grok')
  const empty = fakeCdp({ 'Target.getTargets': { targetInfos: [] } })
  assert.equal(await readPageHint(empty), '')
  assert.ok(!empty.calls.some((call) => call.method === 'Runtime.evaluate'))
})

test('readPageHint: 页面空白时返回空串，不留下光秃秃的域名', async () => {
  const cdp = fakeCdp({
    'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1', url: 'https://grok.com/' }] },
    'Target.attachToTarget': { sessionId: 'S1' },
    'Runtime.evaluate': { result: { value: '   \n  ' } },
    'Target.detachFromTarget': {},
  })
  assert.equal(await readPageHint(cdp), '')
})

test('captureLoginCookies: 登录墙连续 3 次命中才早停，报 AUTH 并给出替代路径', async () => {
  const progress = []
  const cdp = fakeCdp({
    'Storage.getCookies': { cookies: [{ name: 'ct0', value: 'x', domain: '.grok.com' }] },
    'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1', url: 'https://grok.com/' }] },
    'Target.attachToTarget': { sessionId: 'S1' },
    'Runtime.evaluate': { result: { value: 'This account is temporarily limited.' } },
    'Target.detachFromTarget': {},
  })
  await assert.rejects(
    () =>
      captureLoginCookies(cdp, {
        timeoutMs: 60_000,
        hintIntervalMs: 5,
        pollMs: 1,
        onProgress: (message) => progress.push(String(message)),
      }),
    (error) => {
      assert.equal(error.code, 'AUTH')
      assert.ok(error.message.includes('页面提示'), '日志里要能 grep 到这个标记')
      assert.ok(error.message.includes('temporarily limited'), error.message)
      assert.ok(error.message.includes('从调试端口导入'), error.message)
      assert.ok(error.message.includes('「Cookie」框'), error.message)
      assert.ok(error.message.includes('保存并验证'), '手动粘贴这条路要指到面板上按得动的按钮')
      return true
    },
  )
  // 前两跳只提示、不报错：这是「连续命中」判据本身，也是与旧行为（一路干等到超时）的区分点。
  assert.deepEqual(
    progress.filter((line) => line.includes('被限制')).map((line) => (line.includes('1/3') ? 1 : 2)),
    [1, 2],
  )
})

test('captureLoginCookies: 页面文案正常时不早停，超时也带上页面内容和替代路径', async () => {
  const progress = []
  const cdp = fakeCdp({
    'Storage.getCookies': { cookies: [] },
    'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1', url: 'https://grok.com/' }] },
    'Target.attachToTarget': { sessionId: 'S1' },
    'Runtime.evaluate': { result: { value: 'Sign in to grok.com with your username or email.' } },
    'Target.detachFromTarget': {},
  })
  await assert.rejects(
    () =>
      captureLoginCookies(cdp, {
        timeoutMs: 1_200,
        hintIntervalMs: 5,
        pollMs: 1,
        onProgress: (message) => progress.push(String(message)),
      }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT')
      assert.ok(error.message.includes('username or email'), error.message)
      assert.ok(error.message.includes('从调试端口导入'), error.message)
      assert.ok(error.message.includes('「Cookie」框'), error.message)
      return true
    },
  )
  assert.ok(progress.every((line) => !line.includes('被限制')), '正常文案不该判成登录墙')
  assert.ok(progress.some((line) => line.includes('尚未检测到 grok.com 登录态')))
})

test('openExternalLogin: 等 spawn 落地再返回；spawn 异步 error 不能变成未捕获异常', async () => {
  const spawned = []
  const result = await openExternalLogin({
    platform: 'win32',
    spawnImpl: (command, args) => {
      spawned.push({ command, args })
      const child = new EventEmitter()
      setImmediate(() => child.emit('spawn'))
      return child
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'cmd')
  assert.deepEqual(spawned[0].args, ['/c', 'start', '', 'https://grok.com/'])
  assert.ok(result.message.includes('httpOnly'), '提示要说明 document.cookie 取不到 sso')
  assert.ok(result.message.includes('cookie'), '提示要指向设置页的 cookie 字段')

  const failed = await openExternalLogin({
    platform: 'win32',
    spawnImpl: () => {
      const child = new EventEmitter()
      setImmediate(() => child.emit('error', new Error('ENOENT cmd')))
      return child
    },
  })
  assert.equal(failed.ok, false)
  assert.ok(failed.message.includes('ENOENT'), failed.message)
  assert.ok(failed.message.includes('https://grok.com/'), '失败时要把 URL 给用户，让他自己开')

  const thrown = await openExternalLogin({
    platform: 'linux',
    spawnImpl: () => {
      throw new Error('没有 xdg-open')
    },
  })
  assert.equal(thrown.ok, false)
  assert.equal(thrown.via, 'xdg-open')
})

test('captureLoginCookies: 抓到 x-userid + sso 就落盘（verify=false，不发网络请求）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-capture-'))
  const authFile = join(dir, 'auth.json')
  try {
    const cdp = fakeCdp({
      'Storage.getCookies': {
        cookies: [
          { name: 'x-userid', value: '42', domain: '.grok.com' },
          { name: 'sso', value: 'token', domain: '.grok.com', httpOnly: true, secure: true },
          { name: 'unrelated', value: 'nope', domain: '.example.com' },
        ],
      },
    })
    const outcome = await captureLoginCookies(cdp, { authFile, verify: false, userAgent: 'UA-test' })
    assert.equal(outcome.auth.userId, '42')
    assert.equal(outcome.auth.cookieHeader, 'x-userid=42; sso=token')
    const persisted = JSON.parse(readFileSync(authFile, 'utf8'))
    assert.deepEqual(
      persisted.cookies.map((cookie) => cookie.name),
      ['x-userid', 'sso'],
    )
    assert.equal(persisted.userAgent, 'UA-test')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
