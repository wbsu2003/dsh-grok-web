import { browserLogin } from './browser-login.js'
import { readAuth, describeAuth } from './auth.js'
import { verifyHandshake } from './mgw.js'
import { normalizeConfig, unwrapConfig } from './config.js'
import { resolveProxy } from './proxy.js'
import { PROVIDER } from './adapter.js'

export const API_PREFIX = '/grok-web/api'
export const DISPLAY_NAME = 'Grok 网页版'

const MAX_PROGRESS_LINES = 60

/** 错误 → { code, message }，供设置页显示；不带 cookie 等敏感内容。 */
function errorInfo(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN'
  return { code, message: String(error?.message ?? error ?? '未知错误') }
}

/** 代理地址去掉可能的 user:pass，避免在设置页里露出凭据。 */
function safeProxy(config) {
  try {
    const resolved = resolveProxy({ configProxy: config.proxy, targetUrl: 'wss://grok.com/' })
    const url = String(resolved?.url ?? '')
    if (!url) return { url: '', source: resolved?.source ?? 'direct' }
    return { url: url.replace(/\/\/[^/@]*@/, '//'), source: resolved.source }
  } catch (error) {
    return { url: '', source: 'error', error: errorInfo(error).message }
  }
}

/**
 * 设置页面板的宿主 API。DSH 的 client 面板与宿主同源，所以这里只暴露
 * 本插件自己的前缀，且只读登录态摘要 —— 任何路由都不返回 cookie 明文。
 *
 * @param {object} options
 * @param {() => object} [options.resolveConfig] - 返回当前（已摊平 volatile 的）配置
 * @param {object} [options.logger]
 * @param {object} [options.deps] - 单测注入：browserLogin / verifyHandshake / readAuth
 * @param {() => void} [options.onChanged] - 登录任务结束（无论成败）后回调，用于刷新提供商目录
 */
export function createApiHandler(options = {}) {
  const resolveConfig = options.resolveConfig ?? (() => ({}))
  const logger = options.logger ?? {}
  const onChanged = options.onChanged ?? (() => {})
  const deps = { browserLogin, verifyHandshake, readAuth, ...options.deps }
  const config = () => normalizeConfig(unwrapConfig(resolveConfig()))

  /** @type {{kind:string, startedAt:string, lines:string[], done:boolean, result?:object, error?:object}|null} */
  let job = null

  const onProgress = (message) => {
    if (!job) return
    job.lines.push(String(message))
    if (job.lines.length > MAX_PROGRESS_LINES) job.lines.splice(0, job.lines.length - MAX_PROGRESS_LINES)
    logger.info?.(`grok-web: ${message}`)
  }

  function startJob(kind, run) {
    if (job && !job.done) return { started: false, reason: '已有登录抓取任务在运行中' }
    job = { kind, startedAt: new Date().toISOString(), lines: [], done: false }
    run()
      .then((result) => {
        job.done = true
        job.result = result
        onProgress('登录态已保存并通过握手验证')
      })
      .catch((error) => {
        job.done = true
        job.error = errorInfo(error)
        logger.warn?.(`grok-web: ${kind} 失败 [${job.error.code}] ${job.error.message}`)
      })
      .then(() => onChanged())
    return { started: true }
  }

  function statusBody() {
    const current = config()
    let auth
    try {
      auth = describeAuth(deps.readAuth(current))
    } catch (error) {
      const info = errorInfo(error)
      auth = { loggedIn: false, code: info.code, reason: info.message }
    }
    return {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      model: current.model,
      authFile: current.authFile,
      auth,
      proxy: safeProxy(current),
      job,
    }
  }

  async function loginBody(payload) {
    const current = config()
    const port = Number(payload?.cdpPort) || 0
    return startJob(port ? 'import' : 'login', async () => {
      const result = await deps.browserLogin({
        authFile: current.authFile,
        proxy: current.proxy,
        cdpPort: port || undefined,
        timeoutMs: Number(payload?.timeoutMs) || undefined,
        // 附加到别人的浏览器时绝不能关窗
        keepOpen: Boolean(port),
        onProgress,
      })
      return {
        file: result.file,
        sessionId: result.sessionId,
        cookies: Array.isArray(result.auth?.cookies) ? result.auth.cookies.length : undefined,
        capturedAt: result.auth?.capturedAt,
      }
    })
  }

  async function probeBody() {
    const current = config()
    const auth = deps.readAuth(current)
    const proxy = safeProxy(current)
    const verified = await deps.verifyHandshake({ auth, proxy: proxy.url, timeoutMs: current.connectTimeoutMs })
    return { ok: true, sessionId: verified?.sessionId, model: current.model }
  }

  /** webServer 的 prefix handler：`(req, res)`。 */
  return async function handler(req, res) {
    const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    const send = (status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }

    try {
      if (method === 'GET' && (route === '/status' || route === '/' || route === '/job')) return send(200, statusBody())
      if (method === 'POST' && route === '/login') return send(200, await loginBody({}))
      if (method === 'POST' && route === '/import') {
        const payload = await readJson(req)
        if (!(Number(payload?.cdpPort) > 0)) return send(400, { error: { code: 'BAD_REQUEST', message: '缺少 cdpPort' } })
        return send(200, await loginBody(payload))
      }
      if (method === 'POST' && route === '/probe') return send(200, await probeBody())
      return send(404, { error: { code: 'NOT_FOUND', message: `未知路由 ${method} ${route}` } })
    } catch (error) {
      // 握手/读登录态失败是「可用状态」，不是 500：面板要能原样显示原因。
      return send(200, { ok: false, error: errorInfo(error) })
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.setEncoding?.('utf8')
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > 64 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy?.()
      }
    })
    req.on('end', () => {
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}
