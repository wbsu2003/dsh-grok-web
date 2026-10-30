/**
 * 浏览器登录捕获：拉起独立的 Chrome/Edge profile → 用户在窗口里登录 grok.com
 * → CDP 读取 grok.com 的 Cookie → 用一次 mgw 握手验证 → 写入 auth.json。
 *
 * 不碰用户日常浏览器的 profile；也不读 WebView2/其他应用的加密 Cookie 库。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { DEFAULT_USER_AGENT, saveAuthFile, dshHome, isGrokDomain, resolveAuthFile } from './auth.js'
import { findSystemBrowser } from './browser.js'
import { connectCdp } from './cdp.js'
import { GrokError } from './errors.js'
import { verifyHandshake } from './mgw.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function httpGetJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new GrokError(`CDP 端点返回 HTTP ${response.statusCode}：${url}`, 'PROTOCOL'))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(new GrokError(`CDP 端点返回的不是 JSON：${error?.message ?? error}`, 'PROTOCOL'))
        }
      })
    })
    request.on('timeout', () => request.destroy(new GrokError('连接本机 CDP 端点超时', 'TIMEOUT')))
    request.on('error', (error) => reject(error))
  })
}

function devToolsPortFile(profileDir) {
  return join(profileDir, 'DevToolsActivePort')
}

function readDevToolsPort(profileDir) {
  const portFile = devToolsPortFile(profileDir)
  try {
    if (!existsSync(portFile)) return 0
    const port = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0])
    return Number.isInteger(port) && port > 0 ? port : 0
  } catch {
    return 0
  }
}

async function portIsReachable(port, timeoutMs = 1500) {
  try {
    const version = await httpGetJson(`http://127.0.0.1:${port}/json/version`, timeoutMs)
    return Boolean(version?.webSocketDebuggerUrl)
  } catch {
    return false
  }
}

async function waitForDevToolsPort(profileDir, getStatus, timeoutMs) {
  const portFile = devToolsPortFile(profileDir)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const port = readDevToolsPort(profileDir)
    if (port) return port
    const status = getStatus()
    if (status.exited) {
      const reason = status.error ? `：${status.error.message ?? status.error}` : '（可能被已有的浏览器实例接管）'
      throw new GrokError(`浏览器在调试端口就绪前退出${reason}`, 'TRANSPORT')
    }
    await sleep(250)
  }
  throw new GrokError(`等待浏览器调试端口超时（${Math.round(timeoutMs / 1000)}s）`, 'TIMEOUT')
}

async function waitForCdpVersion(port, getStatus, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (getStatus().exited) break
    try {
      const version = await httpGetJson(`http://127.0.0.1:${port}/json/version`, 2_000)
      if (version?.webSocketDebuggerUrl) return version
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  const status = getStatus()
  if (status.exited) {
    const reason = status.error ? `：${status.error.message ?? status.error}` : ''
    throw new GrokError(`浏览器在 CDP 就绪前退出${reason}`, 'TRANSPORT')
  }
  throw new GrokError(
    `无法连接浏览器 CDP 端口 ${port}（${lastError?.code ?? lastError?.message ?? '无响应'}）`,
    'TRANSPORT',
    { cause: lastError },
  )
}

function pickGrokCookies(cookies) {
  return (cookies ?? [])
    .filter((cookie) => cookie && typeof cookie.name === 'string' && isGrokDomain(cookie.domain))
    .map((cookie) => ({
      name: cookie.name,
      value: String(cookie.value ?? ''),
      domain: cookie.domain ?? '',
      path: cookie.path ?? '/',
      ...(Number.isFinite(cookie.expires) ? { expires: cookie.expires } : {}),
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    }))
}

function findCookie(cookies, name) {
  return cookies.find((cookie) => cookie.name === name)?.value ?? ''
}

async function verifyWithRetry(options) {
  const attempts = Math.max(1, Number(options.verifyAttempts) || 4)
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyHandshake({
        auth: options.auth,
        proxy: options.proxy || '',
        timeoutMs: options.verifyTimeoutMs ?? 20_000,
      })
    } catch (error) {
      lastError = error
      const code = error instanceof GrokError ? error.code : 'TRANSPORT'
      if (!['AUTH', 'TIMEOUT', 'TRANSPORT'].includes(code) || attempt === attempts) throw error
      options.onProgress?.(`握手验证第 ${attempt} 次失败（${code}），3 秒后重试…`)
      await sleep(3000)
    }
  }
  throw lastError
}

/**
 * @param {object} options
 * @param {string} [options.authFile]
 * @param {string} [options.browserPath]
 * @param {string} [options.profileDir]
 * @param {string} [options.proxy] - 仅用于 Node 侧握手验证
 * @param {number} [options.timeoutMs] - 等待登录的总时长
 * @param {number} [options.cdpPort] - 附加到已在跑的浏览器调试端口（只读 Cookie，不关窗、不新起进程）
 * @param {boolean} [options.keepOpen]
 * @param {boolean} [options.verify] - 默认 true
 * @param {(message: string) => void} [options.onProgress]
 * @returns {Promise<{auth: object, file: string, browser: {path: string, name: string}, sessionId?: string}>}
 */
export async function browserLogin(options = {}) {
  // 附加模式：连一个已经在跑的、开了调试端口的浏览器（例如带 --remote-debugging-port 的 Chrome），
  // 只读 Cookie，绝不关窗；这种模式不需要本机浏览器可执行文件。
  const attachPort = Number(options.cdpPort) || 0
  let browser = options.browserPath ? { path: String(options.browserPath), name: '指定浏览器' } : null
  if (!attachPort) {
    browser = findSystemBrowser(options.browserPath)
    if (!browser) {
      throw new GrokError(
        '找不到 Chrome / Edge。请安装其中一个，或用 --browser <路径> / 环境变量 GROK_BROWSER_PATH 指定浏览器可执行文件。',
        'TRANSPORT',
      )
    }
  }

  const profileDir = String(options.profileDir ?? '').trim() || join(dshHome(), 'grok-web', 'browser-profile')
  mkdirSync(profileDir, { recursive: true })
  const timeoutMs = Math.max(30_000, Number(options.timeoutMs) || 600_000)
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}

  const portFile = devToolsPortFile(profileDir)
  let port = attachPort || readDevToolsPort(profileDir)
  let child = null
  let exited = false
  let spawnError = null
  const getStatus = () => ({ exited, error: spawnError })

  if (attachPort) {
    if (!(await portIsReachable(port))) {
      throw new GrokError(
        `调试端口 ${port} 上没有可用的浏览器 —— 它需要带 --remote-debugging-port=<端口> 启动`,
        'TRANSPORT',
      )
    }
    onProgress(`连接已有浏览器的调试端口 ${port}（只读取 Cookie，不会关闭它）`)
  } else if (port && (await portIsReachable(port))) {
    onProgress(`检测到已运行的登录浏览器（CDP 端口 ${port}），直接复用`)
  } else {
    if (port) {
      // 上次运行被中断时 Chrome 会把 DevToolsActivePort 留在 profile 里；
      // 端口已不可达，必须清掉，否则新一轮会连到旧端口。
      try {
        rmSync(portFile, { force: true })
      } catch {}
      onProgress('已清理上次残留的调试端口文件')
    }
    port = 0
    const args = [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      // Chrome 会为 --remote-allow-origins=* 显示"不受支持的命令行标记"黄条；
      // 这是专用登录 profile，用 --test-type 抑制提示，不影响页面 HTTPS。
      '--test-type',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      'https://grok.com/',
    ]
    onProgress(`启动 ${browser.name}（独立 profile：${profileDir}）`)
    child = spawn(browser.path, args, { stdio: 'ignore', windowsHide: false })
    child.once('exit', () => {
      exited = true
    })
    child.once('error', (error) => {
      spawnError = error
      exited = true
    })
  }

  let cdp
  try {
    if (!port) port = await waitForDevToolsPort(profileDir, getStatus, 60_000)
    const version = await waitForCdpVersion(port, getStatus)
    onProgress(`浏览器调试端口 ${port} 已就绪，等待登录…`)
    cdp = await connectCdp(version.webSocketDebuggerUrl)
    const browserVersion = await cdp.send('Browser.getVersion')
    const userAgent = String(browserVersion?.userAgent ?? '').trim()
    onProgress('请在打开的浏览器窗口里完成 grok.com 登录（已有登录态会自动复用）。')

    const deadline = Date.now() + timeoutMs
    let lastHintAt = 0
    while (Date.now() < deadline) {
      if (exited) throw new GrokError('浏览器已关闭，登录捕获中止', 'TRANSPORT')
      let result
      try {
        result = await cdp.send('Storage.getCookies')
      } catch (error) {
        throw new GrokError(`读取浏览器 Cookie 失败（浏览器可能已关闭）：${error?.message ?? error}`, 'TRANSPORT')
      }
      const cookies = pickGrokCookies(result?.cookies)
      const userId = findCookie(cookies, 'x-userid')
      const sso = findCookie(cookies, 'sso') || findCookie(cookies, 'sso-rw')
      if (userId && sso) {
        const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
        const auth = {
          userId,
          userAgent: userAgent || DEFAULT_USER_AGENT,
          cookies,
          cookieHeader,
          capturedAt: new Date().toISOString(),
        }
        if (options.verify === false) {
          const file = saveAuthFile(options.authFile, auth)
          return { auth, file, browser }
        }
        try {
          onProgress('已检测到登录 Cookie，正在用 mgw 握手验证…')
          const verified = await verifyWithRetry({
            auth,
            proxy: options.proxy,
            onProgress,
            verifyAttempts: options.verifyAttempts,
          })
          const file = saveAuthFile(options.authFile, auth)
          return { auth, file, browser, sessionId: verified.sessionId }
        } catch (error) {
          const detail = error instanceof GrokError ? `${error.code}: ${error.message}` : String(error)
          throw new GrokError(`登录 Cookie 已捕获，但 mgw 握手验证失败：${detail}`, 'AUTH', { cause: error })
        }
      }

      const now = Date.now()
      if (now - lastHintAt > 20_000) {
        lastHintAt = now
        onProgress(
          userId
            ? `已看到 x-userid，但还没有 sso 登录 Cookie —— 请在页面里完成登录（剩余 ${Math.ceil((deadline - now) / 1000)}s）`
            : `尚未检测到 grok.com 登录态（剩余 ${Math.ceil((deadline - now) / 1000)}s）`,
        )
      }
      await sleep(2000)
    }
    throw new GrokError(`等待登录超时（${Math.round(timeoutMs / 1000)}s）`, 'TIMEOUT')
  } finally {
    if (cdp) {
      if (!options.keepOpen && !attachPort) {
        try {
          await cdp.send('Browser.close')
        } catch {}
        await sleep(500)
        if (!exited && child) {
          try {
            child.kill()
          } catch {}
        }
      }
      cdp.close()
    } else if (!options.keepOpen && child) {
      try {
        child.kill()
      } catch {}
    }
    if (options.keepOpen) onProgress(`浏览器保持打开；下次可直接复用 profile：${profileDir}`)
  }
}

/**
 * 手动 Cookie 模式：验证（可选）后写入 auth.json。
 */
export async function saveCookieAuth(options = {}) {
  const raw = String(options.cookie ?? '').trim().replace(/^cookie:\s*/i, '')
  if (!raw) throw new GrokError('--cookie 为空', 'MISSING_CREDENTIAL')
  const cookies = raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf('=')
      return {
        name: index < 0 ? pair : pair.slice(0, index).trim(),
        value: index < 0 ? '' : pair.slice(index + 1).trim(),
        domain: '.grok.com',
        path: '/',
      }
    })
  const userId = String(options.userId ?? '').trim() || findCookie(cookies, 'x-userid')
  if (!userId) throw new GrokError('cookie 里缺少 x-userid，请用 --user-id 指定', 'MISSING_CREDENTIAL')
  const auth = {
    userId,
    userAgent: String(options.userAgent ?? '').trim() || DEFAULT_USER_AGENT,
    cookies,
    capturedAt: new Date().toISOString(),
  }
  if (options.verify !== false) {
    const verified = await verifyWithRetry({ auth: { ...auth, cookieHeader: raw, userId }, proxy: options.proxy })
    const file = saveAuthFile(options.authFile, auth)
    return { auth, file, sessionId: verified.sessionId }
  }
  const file = saveAuthFile(options.authFile, auth)
  return { auth, file }
}

export async function readAuthStatus(options = {}) {
  const { readAuth } = await import('./auth.js')
  const auth = readAuth({
    authFile: options.authFile,
    cookie: options.cookie,
    userId: options.userId,
    userAgent: options.userAgent,
  })
  if (options.verify === false) return { auth }
  const verified = await verifyWithRetry({ auth, proxy: options.proxy })
  return { auth, sessionId: verified.sessionId }
}

export { resolveAuthFile }
