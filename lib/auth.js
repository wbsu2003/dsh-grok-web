/**
 * 登录态读取：`auth.json`（由 scripts/login.mjs 写入）或配置里直接给 cookie。
 *
 * 认证只依赖 grok.com 的真实 Cookie（含 httpOnly 的 sso），握手时原样带上；
 * 其中非 httpOnly 的 `x-userid` 同时是 mgw WebSocket 的 `uid` 查询参数。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { GrokError } from './errors.js'

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : join(homedir(), '.dsh')
}

export function defaultAuthFile() {
  return join(dshHome(), 'grok-web', 'auth.json')
}

export function resolveAuthFile(file) {
  const text = String(file ?? '').trim()
  if (!text) return defaultAuthFile()
  return isAbsolute(text) ? text : resolve(text)
}

export function isGrokDomain(domain) {
  const normalized = String(domain ?? '').trim().replace(/^\./, '').toLowerCase()
  if (!normalized) return true
  return normalized === 'grok.com' || normalized.endsWith('.grok.com')
}

export function parseCookieHeader(raw) {
  const text = String(raw ?? '').trim().replace(/^cookie:\s*/i, '')
  return text
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
}

function pairName(pair) {
  const index = pair.indexOf('=')
  return index <= 0 ? '' : pair.slice(0, index).trim()
}

function pairValue(pair) {
  const index = pair.indexOf('=')
  return index < 0 ? '' : pair.slice(index + 1).trim()
}

export function findCookie(pairs, name) {
  for (const pair of pairs) {
    if (pairName(pair) === name) return pairValue(pair)
  }
  return ''
}

function headerFromCookieRecords(cookies) {
  const pairs = []
  for (const cookie of cookies ?? []) {
    if (!cookie || typeof cookie !== 'object') continue
    if (!isGrokDomain(cookie.domain)) continue
    const name = String(cookie.name ?? '').trim()
    if (!name) continue
    const value = String(cookie.value ?? '')
    pairs.push(`${name}=${value}`)
  }
  return pairs
}

function readAuthFile(file) {
  if (!existsSync(file)) {
    throw new GrokError(
      `没有找到 Grok 登录态文件：${file}\n先运行：node scripts/login.mjs（或在本插件目录执行 npm run login）`,
      'MISSING_CREDENTIAL',
    )
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new GrokError(`Grok 登录态文件无法解析：${file}（${error?.message ?? error}）`, 'MISSING_CREDENTIAL')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new GrokError(`Grok 登录态文件格式不对：${file}`, 'MISSING_CREDENTIAL')
  }
  return parsed
}

/**
 * @param {object} config - 插件配置
 * @returns {{cookieHeader: string, userId: string, userAgent: string, capturedAt?: string,
 *   displayName?: string, source: 'config'|'file', file?: string, expiredCookies: string[]}}
 */
export function readAuth(config = {}) {
  const configuredCookie = typeof config.cookie === 'string' ? config.cookie.trim() : ''
  if (configuredCookie) {
    const pairs = parseCookieHeader(configuredCookie)
    const userId = String(config.userId ?? '').trim() || findCookie(pairs, 'x-userid')
    if (!userId) {
      throw new GrokError(
        '配置里的 cookie 缺少 x-userid（Grok 的 uid 参数取自这个非 httpOnly cookie）；请从已登录的 grok.com 页面复制完整 Cookie',
        'MISSING_CREDENTIAL',
      )
    }
    return {
      cookieHeader: pairs.join('; '),
      userId,
      userAgent: String(config.userAgent ?? '').trim() || DEFAULT_USER_AGENT,
      source: 'config',
      expiredCookies: [],
    }
  }

  const file = resolveAuthFile(config.authFile)
  const stored = readAuthFile(file)
  const pairs = Array.isArray(stored.cookies)
    ? headerFromCookieRecords(stored.cookies)
    : parseCookieHeader(stored.cookieHeader ?? stored.cookie ?? '')

  if (pairs.length === 0) {
    throw new GrokError(
      `Grok 登录态文件里没有可用的 cookie：${file}\n重新运行：node scripts/login.mjs`,
      'MISSING_CREDENTIAL',
    )
  }

  const userId = findCookie(pairs, 'x-userid') || String(stored.userId ?? '').trim()
  if (!userId) {
    throw new GrokError(
      `Grok 登录态文件缺少 x-userid（uid 参数取自这个 cookie）：${file}\n重新运行：node scripts/login.mjs`,
      'MISSING_CREDENTIAL',
    )
  }

  const expiredCookies = []
  const now = Date.now()
  for (const cookie of Array.isArray(stored.cookies) ? stored.cookies : []) {
    if (!cookie || cookie.name === undefined || !isGrokDomain(cookie.domain)) continue
    const expires = Number(cookie.expires)
    if (Number.isFinite(expires) && expires > 0 && expires * 1000 < now) {
      expiredCookies.push(String(cookie.name))
    }
  }

  return {
    cookieHeader: pairs.join('; '),
    userId,
    userAgent: String(stored.userAgent ?? '').trim() || DEFAULT_USER_AGENT,
    ...(stored.capturedAt ? { capturedAt: String(stored.capturedAt) } : {}),
    ...(stored.displayName ? { displayName: String(stored.displayName) } : {}),
    source: 'file',
    file,
    expiredCookies,
  }
}

export function saveAuthFile(file, auth) {
  const target = resolveAuthFile(file)
  mkdirSync(dirname(target), { recursive: true })
  const payload = {
    version: 1,
    provider: 'grok-web',
    capturedAt: auth.capturedAt ?? new Date().toISOString(),
    userId: String(auth.userId ?? ''),
    userAgent: String(auth.userAgent ?? DEFAULT_USER_AGENT),
    ...(auth.displayName ? { displayName: String(auth.displayName) } : {}),
    cookies: Array.isArray(auth.cookies) ? auth.cookies : [],
  }
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return target
}

export function maskValue(value, keep = 6) {
  const text = String(value ?? '')
  if (!text) return ''
  if (text.length <= keep * 2) return `${text.slice(0, Math.max(1, keep - 1))}…`
  return `${text.slice(0, keep)}…${text.slice(-4)}`
}

export function describeAuth(auth) {
  if (!auth) return { loggedIn: false }
  return {
    loggedIn: true,
    source: auth.source,
    userId: maskValue(auth.userId, 8),
    ...(auth.file ? { file: auth.file } : {}),
    ...(auth.capturedAt ? { capturedAt: auth.capturedAt } : {}),
    ...(auth.expiredCookies?.length ? { expiredCookies: auth.expiredCookies } : {}),
  }
}
