/**
 * 系统浏览器定位。登录捕获需要一个真实的 Chrome / Edge（headful），
 * 复用系统代理与浏览器的登录能力；不接管用户日常使用的 profile。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (existsSync(candidate)) return candidate
    } catch {}
  }
  return ''
}

function which(names) {
  for (const name of names) {
    try {
      const output = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const first = String(output)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && existsSync(line))
      if (first) return first
    } catch {}
  }
  return ''
}

/** 本机装了哪些可用的浏览器，按 id 去重（同一个 Edge 只留第一个命中的路径）。 */
function candidates() {
  const out = []
  const push = (id, name, path) => {
    if (path && !out.some((entry) => entry.id === id)) out.push({ id, name, path })
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? ''
    const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    push(
      'edge',
      'Microsoft Edge',
      firstExisting([
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]),
    )
    push(
      'chrome',
      'Google Chrome',
      firstExisting([
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        local ? join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      ]),
    )
    const fromPath = which(['chrome.exe', 'msedge.exe'])
    if (fromPath) push(fromPath.toLowerCase().includes('edge') ? 'edge' : 'chrome', undefined, fromPath)
    return out
  }
  if (process.platform === 'darwin') {
    push(
      'edge',
      'Microsoft Edge',
      firstExisting(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']),
    )
    push(
      'chrome',
      'Google Chrome',
      firstExisting([
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]),
    )
    return out
  }
  push('edge', 'Microsoft Edge', which(['microsoft-edge']))
  push(
    'chrome',
    'Google Chrome',
    which(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']),
  )
  return out
}

/**
 * @param {Array<{id:string,name?:string,path:string}>} list
 * @param {string} [prefer] - 'edge' / 'chrome'；没指定或没装时按列表顺序回落
 */
export function pickBrowser(list, prefer) {
  const wanted = String(prefer ?? '').trim().toLowerCase()
  if (wanted) return list.find((entry) => entry.id === wanted) ?? null
  return list[0] ?? null
}

/** @returns {Array<{id:string,name:string,path:string}>} */
export function listSystemBrowsers() {
  return candidates().map((entry) => ({ ...entry, name: entry.name ?? (entry.id === 'edge' ? 'Microsoft Edge' : 'Google Chrome') }))
}

/**
 * @param {string} [explicit] - 直接给可执行文件路径（或 GROK_BROWSER_PATH）
 * @param {string} [prefer] - 'edge' / 'chrome'
 * @returns {{path: string, name: string, id: string} | null}
 */
export function findSystemBrowser(explicit, prefer) {
  const wanted = String(explicit ?? process.env.GROK_BROWSER_PATH ?? '').trim()
  if (wanted) {
    if (!existsSync(wanted)) throw new Error(`指定的浏览器不存在：${wanted}`)
    const lower = wanted.toLowerCase()
    const id = lower.includes('msedge') ? 'edge' : 'chrome'
    return { path: wanted, name: `指定浏览器（${lower.includes('msedge') ? 'Edge' : 'Chrome'}）`, id }
  }
  const list = listSystemBrowsers()
  return pickBrowser(list, prefer)
}

