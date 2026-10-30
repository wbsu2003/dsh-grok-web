/**
 * 代理解析：配置 > 环境变量 > Windows 系统代理（WinINET）。
 *
 * 只支持 http:// / https:// 代理（wss 走 HTTP CONNECT）。SOCKS 明确报错，
 * 不做半吊子降级 —— 静默直连会让用户以为插件坏了。
 */
import { execFileSync } from 'node:child_process'

const CACHE_MS = 30_000
let registryCache = { at: 0, value: '' }

function envValue(env, names) {
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function normalizeProxyUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (/^(direct|none|off)$/i.test(text)) return ''
  let candidate = text
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `http://${candidate}`
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的代理协议 ${parsed.protocol}（只支持 http/https；SOCKS 请用本地 http 代理转一层）`)
  }
  return parsed.toString()
}

/** NO_PROXY 命中判定：支持 `*`、域名后缀、host:port、IP。 */
export function shouldBypassProxy(noProxy, host, port) {
  const text = String(noProxy ?? '').trim()
  if (!text) return false
  const hostname = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  const portText = port === undefined || port === null ? '' : String(port)
  for (const rawEntry of text.split(/[\s,]+/)) {
    let entry = rawEntry.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    let entryPort = ''
    const portMatch = /^(.*):(\d+)$/.exec(entry)
    if (portMatch && !entry.startsWith('[')) {
      entry = portMatch[1]
      entryPort = portMatch[2]
    }
    entry = entry.replace(/^\[|\]$/g, '').replace(/^\./, '')
    if (entryPort && entryPort !== portText) continue
    if (hostname === entry) return true
    if (hostname.endsWith(`.${entry}`)) return true
  }
  return false
}

function parseWindowsProxyServer(server) {
  const text = String(server ?? '').trim()
  if (!text) return ''
  if (!text.includes('=')) return normalizeProxyUrl(text)
  const pairs = new Map()
  for (const part of text.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    pairs.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim())
  }
  return normalizeProxyUrl(pairs.get('https') || pairs.get('http') || '')
}

function readWindowsProxyFromRegistry() {
  const now = Date.now()
  if (now - registryCache.at < CACHE_MS) return registryCache.value
  let value = ''
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const enable = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
    if (/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enable)) {
      const server = execFileSync('reg', ['query', key, '/v', 'ProxyServer'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
      })
      const matched = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(server)
      if (matched) value = parseWindowsProxyServer(matched[1])
    }
  } catch {
    value = ''
  }
  registryCache = { at: now, value }
  return value
}

/**
 * @param {object} options
 * @param {string|false|null|undefined} options.configProxy - 配置里的 proxy；undefined/'auto' 走自动探测，false/'direct' 表示直连
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.targetUrl] - 目标 URL（用于 NO_PROXY 与协议选择）
 * @param {string} [options.platform]
 * @param {(host: string, port: number) => string} [options.registryReader] - 单测注入
 * @returns {{ url: string, source: 'config'|'env'|'registry'|'direct'|'bypass', warning?: string }}
 */
export function resolveProxy(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const target = options.targetUrl ? new URL(options.targetUrl) : new URL('wss://grok.com/')
  const targetPort = target.port ? Number(target.port) : target.protocol === 'wss:' || target.protocol === 'https:' ? 443 : 80

  const noProxy = envValue(env, ['NO_PROXY', 'no_proxy'])
  if (shouldBypassProxy(noProxy, target.hostname, targetPort)) {
    return { url: '', source: 'bypass' }
  }

  const configProxy = options.configProxy
  if (configProxy === false || (typeof configProxy === 'string' && /^(direct|none|off)$/i.test(configProxy.trim()))) {
    return { url: '', source: 'direct' }
  }
  if (typeof configProxy === 'string' && configProxy.trim() && configProxy.trim().toLowerCase() !== 'auto') {
    return { url: normalizeProxyUrl(configProxy), source: 'config' }
  }

  const isSecure = target.protocol === 'wss:' || target.protocol === 'https:'
  const envProxy = isSecure
    ? envValue(env, ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'])
    : envValue(env, ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'])
  if (envProxy) {
    return { url: normalizeProxyUrl(envProxy), source: 'env' }
  }

  if (platform === 'win32') {
    const registryProxy = (options.registryReader
      ? options.registryReader('ProxyServer', target.hostname, targetPort)
      : readWindowsProxyFromRegistry()) || ''
    if (registryProxy) return { url: normalizeProxyUrl(registryProxy), source: 'registry' }
  }

  return { url: '', source: 'direct' }
}

/** 把代理 URL 拆成 WS 客户端要的字段（含 Basic 认证头）。 */
export function proxyParts(proxyUrl) {
  const text = String(proxyUrl ?? '').trim()
  if (!text) return null
  const parsed = new URL(text)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的代理协议 ${parsed.protocol}`)
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  let authorization = ''
  if (parsed.username || parsed.password) {
    const user = decodeURIComponent(parsed.username)
    const pass = decodeURIComponent(parsed.password)
    authorization = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`
  }
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port,
    secure: parsed.protocol === 'https:',
    authorization,
  }
}
