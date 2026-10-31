import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createApiHandler, API_PREFIX, DISPLAY_NAME } from '../lib/api.js'

const FAKE_AUTH = {
  cookieHeader: 'sso=top-secret-token; x-userid=u1234567890',
  userId: 'u1234567890',
  userAgent: 'UA/1.0',
  source: 'file',
  file: 'C:/fake/auth.json',
  capturedAt: '2026-10-23T00:00:00.000Z',
  expiredCookies: [],
}

function failingReadAuth(error) {
  return () => {
    const err = new Error(error ?? '没有找到 Grok 登录态文件')
    err.code = 'MISSING_CREDENTIAL'
    throw err
  }
}

/** 组装一次请求：返回解析后的 JSON 响应体，并把异步登录任务等干。 */
async function request(handler, { method = 'GET', path = '/status', body } = {}) {
  // 非 GET 一律给一条流：真实 IncomingMessage 总是可流的，readJson 也依赖这一点。
  const req =
    body === undefined && method === 'GET'
      ? { method, url: `${API_PREFIX}${path}` }
      : Object.assign(Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))]), {
          method,
          url: `${API_PREFIX}${path}`,
        })
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(text) {
      this.body = String(text ?? '')
    },
  }
  await handler(req, res)
  const raw = normalizeProxyUrls(res.body)
  return { status: res.statusCode, json: JSON.parse(raw || 'null'), raw }
}

function flushJobs() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 把响应体里的代理 URL 归一化，避开 normalizeProxyUrl 补的尾斜杠。 */
function normalizeProxyUrls(body) {
  return body.replaceAll('http://127.0.0.1:8080/', 'http://127.0.0.1:8080')
}

function handlerWith(deps, config = { proxy: 'off' }) {
  const logs = []
  const changes = []
  const handler = createApiHandler({
    resolveConfig: () => config,
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
    onChanged: () => changes.push(1),
    // 默认不碰文件系统/不真起进程；单个测试要验哪条就覆盖哪条。
    deps: {
      listSystemBrowsers: () => [],
      openExternalLogin: async () => ({ ok: true }),
      saveCookieAuth: () => Promise.reject(new Error('测试未注入 saveCookieAuth，绝不写真实登录态文件')),
      ...deps,
    },
  })
  return { handler, logs, changes }
}

test('GET /status: 未登录时给出原因，不泄露任何 cookie 内容', async () => {
  const { handler } = handlerWith({ readAuth: failingReadAuth() })
  const { status, json } = await request(handler)
  assert.equal(status, 200)
  assert.equal(json.provider, 'grok-web')
  assert.equal(json.displayName, DISPLAY_NAME)
  assert.equal(json.job, null)
  assert.equal(json.auth.loggedIn, false)
  assert.equal(json.auth.code, 'MISSING_CREDENTIAL')
  assert.equal(json.proxy.url, '')
  assert.equal(json.proxy.source, 'direct')
})

test('GET /status: 已登录只回显掩码 userId 与文件路径', async () => {
  const { handler } = handlerWith({ readAuth: () => FAKE_AUTH })
  const { json, raw } = await request(handler, { path: '/' })
  assert.equal(json.auth.loggedIn, true)
  assert.equal(json.auth.source, 'file')
  assert.ok(json.auth.userId.includes('…'), json.auth.userId)
  assert.ok(!raw.includes('top-secret-token'), 'status 里绝不能出现 cookie 明文')
  assert.ok(!raw.includes('sso='), 'status 里绝不能出现 cookie 明文')
})

test('POST /login: 抓取任务串行、进度可见、结束后通知刷新目录', async () => {
  let calls = 0
  let onProgress
  let finish
  const { handler, changes } = handlerWith({
    readAuth: () => FAKE_AUTH,
    browserLogin: (options) => {
      calls += 1
      onProgress = options.onProgress
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            file: 'C:/fake/auth.json',
            sessionId: 'sess-1',
            auth: { cookies: [{ name: 'sso', value: 'x' }, { name: 'x-userid', value: 'u1234567890' }], capturedAt: 'now' },
          })
      })
    },
    verifyHandshake: () => Promise.resolve({ sessionId: 'sess-1' }),
  })

  const first = await request(handler, { method: 'POST', path: '/login' })
  assert.deepEqual(first.json, { started: true })
  const second = await request(handler, { method: 'POST', path: '/login' })
  assert.equal(second.json.started, false)
  assert.ok(second.json.reason.includes('运行中'), JSON.stringify(second.json))
  assert.equal(calls, 1)

  onProgress('等待登录…')
  finish()
  await flushJobs()

  const status = await request(handler, { path: '/job' })
  assert.equal(status.json.job.done, true)
  assert.equal(status.json.job.kind, 'login')
  assert.deepEqual(status.json.job.result, { file: 'C:/fake/auth.json', sessionId: 'sess-1', cookies: 2, capturedAt: 'now' })
  assert.ok(status.json.job.lines.includes('等待登录…'))
  assert.ok(status.json.job.lines.some((line) => line.includes('握手验证')))
  assert.equal(changes.length, 1)
})

test('POST /login: 抓取失败也记入任务并回调目录刷新', async () => {
  const { handler, changes, logs } = handlerWith({
    readAuth: () => FAKE_AUTH,
    browserLogin: () => {
      const error = new Error('用户关闭窗口')
      error.code = 'TRANSPORT'
      return Promise.reject(error)
    },
  })
  await request(handler, { method: 'POST', path: '/login' })
  await flushJobs()
  const { json } = await request(handler, { path: '/job' })
  assert.equal(json.job.done, true)
  assert.equal(json.job.error.code, 'TRANSPORT')
  assert.equal(json.job.result, undefined)
  assert.equal(changes.length, 1)
  assert.ok(logs.some((line) => line.includes('login 失败')))
})

test('POST /import: 必须给 cdpPort，且附加模式绝不关用户的浏览器', async () => {
  const missing = handlerWith({ readAuth: () => FAKE_AUTH })
  const bad = await request(missing.handler, { method: 'POST', path: '/import', body: {} })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'BAD_REQUEST')

  let options
  const ok = handlerWith({
    readAuth: () => FAKE_AUTH,
    browserLogin: (input) => {
      options = input
      return Promise.resolve({ file: 'f', sessionId: 's', auth: { cookies: [] } })
    },
  })
  const started = await request(ok.handler, { method: 'POST', path: '/import', body: { cdpPort: 9222 } })
  assert.deepEqual(started.json, { started: true })
  await flushJobs()
  assert.equal(options.cdpPort, 9222)
  assert.equal(options.keepOpen, true)
  const { json } = await request(ok.handler, { path: '/job' })
  assert.equal(json.job.kind, 'import')
})

test('POST /import: 非法 JSON 请求体被拒绝', async () => {
  const { handler } = handlerWith({ readAuth: () => FAKE_AUTH })
  const req = Object.assign(Readable.from([Buffer.from('{not json')]), { method: 'POST', url: `${API_PREFIX}/import` })
  const res = { writeHead() {}, end() {} }
  const sent = []
  res.writeHead = (status, headers) => sent.push(status, headers)
  res.end = (text) => sent.push(JSON.parse(text))
  await handler(req, res)
  assert.equal(sent[0], 200)
  assert.equal(sent[2].error.code, 'UNKNOWN')
  assert.ok(sent[2].error.message.includes('合法 JSON'), sent[2].error.message)
})

test('POST /probe: 透传掩码前的登录态给握手，只回 sessionId', async () => {
  let seen
  const { handler } = handlerWith({
    readAuth: () => FAKE_AUTH,
    verifyHandshake: (options) => {
      seen = options
      return Promise.resolve({ sessionId: 'sess-42' })
    },
  })
  const { status, json } = await request(handler, { method: 'POST', path: '/probe' })
  assert.equal(status, 200)
  assert.deepEqual(json, { ok: true, sessionId: 'sess-42', model: 'fast' })
  assert.equal(seen.auth, FAKE_AUTH)
  assert.equal(seen.proxy, '')
})

test('POST /probe: 登录态缺失按可用状态返回 200 + 错误码', async () => {
  const { handler } = handlerWith({ readAuth: failingReadAuth('Grok 登录态文件缺少 x-userid') })
  const { status, json } = await request(handler, { method: 'POST', path: '/probe' })
  assert.equal(status, 200)
  assert.equal(json.ok, false)
  assert.equal(json.error.code, 'MISSING_CREDENTIAL')
})

test('未知路由与未知方法返回 404', async () => {
  const { handler } = handlerWith({ readAuth: () => FAKE_AUTH })
  assert.equal((await request(handler, { path: '/nope' })).status, 404)
  assert.equal((await request(handler, { method: 'POST', path: '/status' })).status, 404)
})

test('浏览器登录请求里带上配置的 authFile 与代理', async () => {
  let options
  const { handler } = handlerWith(
    {
      readAuth: () => FAKE_AUTH,
      browserLogin: (input) => {
        options = input
        return Promise.resolve({ file: input.authFile, sessionId: 's', auth: { cookies: [] } })
      },
    },
    { authFile: 'C:/somewhere/else.json', proxy: 'http://127.0.0.1:8080' },
  )
  await request(handler, { method: 'POST', path: '/login' })
  await flushJobs()
  assert.equal(options.authFile, 'C:/somewhere/else.json')
  assert.equal(options.proxy, 'http://127.0.0.1:8080')
  const { json } = await request(handler, { path: '/status' })
  assert.equal(json.authFile, 'C:/somewhere/else.json')
  assert.equal(json.proxy.source, 'config')
  assert.equal(json.proxy.url, 'http://127.0.0.1:8080')
})

test('POST /login 把浏览器偏好原样带给捕获；status 报本机可用浏览器', async () => {
  const seen = []
  const { handler } = handlerWith(
    {
      readAuth: () => FAKE_AUTH,
      listSystemBrowsers: () => [
        { id: 'edge', name: 'Microsoft Edge', path: 'C:/edge/msedge.exe' },
        { id: 'chrome', name: 'Google Chrome', path: 'C:/chrome/chrome.exe' },
      ],
      browserLogin: (input) => {
        seen.push(input)
        return Promise.resolve({ file: input.authFile, sessionId: 's', auth: { cookies: [] }, browser: { id: input.browser, name: 'x' } })
      },
    },
    { proxy: 'off' },
  )
  const status = (await request(handler, { path: '/status' })).json
  assert.deepEqual(
    status.browsers,
    [
      { id: 'edge', name: 'Microsoft Edge' },
      { id: 'chrome', name: 'Google Chrome' },
    ],
  )
  assert.ok(!JSON.stringify(status).includes('msedge.exe'), 'status 不回浏览器路径')

  await request(handler, { method: 'POST', path: '/login', body: { browser: 'chrome' } })
  await flushJobs()
  assert.equal(seen[0].browser, 'chrome')
  await request(handler, { method: 'POST', path: '/login', body: {} })
  await flushJobs()
  assert.equal(seen[1].browser, undefined, '没给偏好就交给服务端按默认顺序挑')
})

test('POST /external 只负责开默认浏览器，不碰登录任务', async () => {
  let calls = 0
  const { handler, changes } = handlerWith({
    readAuth: () => FAKE_AUTH,
    browserLogin: () => {
      calls += 1
      return Promise.resolve({ auth: { cookies: [] } })
    },
    openExternalLogin: async () => ({ ok: true, url: 'https://grok.com/', via: 'cmd', message: '已打开，请按提示粘贴 cookie' }),
  })
  const { json } = await request(handler, { method: 'POST', path: '/external' })
  assert.equal(json.ok, true)
  assert.equal(json.message.includes('cookie'), true)
  assert.equal(calls, 0, '开默认浏览器不该启动抓取任务')
  assert.equal((await request(handler, { path: '/status' })).json.job, null)
  assert.equal(changes.length, 0)
})

test('POST /cookie: 先落盘再单发握手，响应不含 Cookie 明文，并通知目录刷新', async () => {
  const seen = {}
  const { handler, changes } = handlerWith(
    {
      readAuth: (config) => {
        seen.read = config
        return FAKE_AUTH
      },
      saveCookieAuth: (options) => {
        seen.save = options
        return Promise.resolve({
          file: options.authFile,
          auth: { cookies: [{ name: 'x-userid', value: 'u1' }, { name: 'sso', value: 't' }], userId: 'u1' },
        })
      },
      verifyHandshake: (options) => {
        seen.verify = options
        return Promise.resolve({ sessionId: 'sess-9' })
      },
    },
    { proxy: 'off', authFile: 'C:/fake/auth.json' },
  )
  const { status, json, raw } = await request(handler, {
    method: 'POST',
    path: '/cookie',
    body: { cookie: 'x-userid=u1234567890; sso=pasted-secret-value' },
  })
  assert.equal(status, 200)
  assert.equal(seen.save.cookie, 'x-userid=u1234567890; sso=pasted-secret-value')
  assert.equal(seen.save.authFile, 'C:/fake/auth.json')
  assert.equal(seen.save.verify, false, '落盘阶段不做验证，验证由 api 单发一次')
  assert.equal(seen.read.cookie, '', '读登录态要绕过设置页里的 cookie 字段，否则刚写入的文件被旧值盖住')
  assert.equal(seen.verify.auth, FAKE_AUTH)
  assert.deepEqual(json, { ok: true, file: 'C:/fake/auth.json', cookies: 2, sessionId: 'sess-9' })
  assert.ok(!raw.includes('pasted-secret-value'), '响应里绝不能出现 Cookie 明文')
  assert.ok(!raw.includes('sso='), '响应里绝不能出现 Cookie 明文')
  assert.equal(changes.length, 1)
})

test('POST /cookie: 握手失败保留已写入的登录态，并把原因原样给出', async () => {
  const { handler, changes } = handlerWith(
    {
      readAuth: () => FAKE_AUTH,
      saveCookieAuth: (options) => Promise.resolve({ file: options.authFile, auth: {} }),
      verifyHandshake: () => Promise.reject(Object.assign(new Error('代理连不通'), { code: 'TRANSPORT' })),
    },
    { proxy: 'off', authFile: 'C:/fake/auth.json' },
  )
  const { json } = await request(handler, { method: 'POST', path: '/cookie', body: { cookie: 'x-userid=u1' } })
  assert.equal(json.ok, true)
  assert.equal(json.file, 'C:/fake/auth.json')
  assert.equal(json.sessionId, undefined)
  assert.equal(json.cookies, undefined, 'auth 里没有 cookies 数组时不要瞎报条数')
  assert.deepEqual(json.verifyError, { code: 'TRANSPORT', message: '代理连不通' })
  assert.equal(changes.length, 1, '登录态已经变了，目录要刷新')
})

test('POST /cookie: 空白 Cookie 直接 400，不碰登录态文件', async () => {
  let calls = 0
  const { handler, changes } = handlerWith({
    readAuth: () => FAKE_AUTH,
    saveCookieAuth: () => {
      calls += 1
      return Promise.resolve({ file: 'x', auth: {} })
    },
  })
  const { status, json } = await request(handler, { method: 'POST', path: '/cookie', body: { cookie: '   ' } })
  assert.equal(status, 400)
  assert.equal(json.error.code, 'BAD_REQUEST')
  assert.equal(calls, 0)
  assert.equal(changes.length, 0)
})

test('status: 设置页填过 cookie 只报布尔，不回报内容', async () => {
  const { handler } = handlerWith({ readAuth: () => FAKE_AUTH }, { proxy: 'off', cookie: 'sso=never-echo-me' })
  const { json, raw } = await request(handler, { path: '/status' })
  assert.equal(json.configCookie, true)
  assert.ok(!raw.includes('never-echo-me'), raw)
})

test('代理 URL 里的凭据不会出现在 status 中', async () => {
  const { handler } = handlerWith({ readAuth: () => FAKE_AUTH }, { proxy: 'http://user:pa55word@127.0.0.1:8080' })
  const { raw } = await request(handler, { path: '/status' })
  assert.ok(!raw.includes('pa55word'), raw)
  assert.ok(raw.includes('http://127.0.0.1:8080'), raw)
})
