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

/** @returns {{path: string, name: string} | null} */
export function findSystemBrowser(explicit) {
  const wanted = String(explicit ?? process.env.GROK_BROWSER_PATH ?? '').trim()
  if (wanted) {
    if (!existsSync(wanted)) throw new Error(`指定的浏览器不存在：${wanted}`)
    return { path: wanted, name: 'custom' }
  }

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? ''
    const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    const chrome = firstExisting([
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local ? join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    ])
    if (chrome) return { path: chrome, name: 'Chrome' }
    const edge = firstExisting([
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ])
    if (edge) return { path: edge, name: 'Edge' }
    const fromPath = which(['chrome.exe', 'msedge.exe'])
    if (fromPath) return { path: fromPath, name: fromPath.toLowerCase().includes('edge') ? 'Edge' : 'Chrome' }
    return null
  }

  if (process.platform === 'darwin') {
    const found = firstExisting([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ])
    return found ? { path: found, name: 'Chrome/Edge' } : null
  }

  const fromPath = which(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'])
  return fromPath ? { path: fromPath, name: 'Chromium' } : null
}
