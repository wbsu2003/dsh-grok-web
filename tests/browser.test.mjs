import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pickBrowser } from '../lib/browser.js'

const EDGE = { id: 'edge', name: 'Microsoft Edge', path: 'C:/Edge/msedge.exe' }
const CHROME = { id: 'chrome', name: 'Google Chrome', path: 'C:/Chrome/chrome.exe' }

test('pickBrowser: 按偏好挑，偏好没装就返回 null 交给调用方回落', () => {
  assert.deepEqual(pickBrowser([EDGE, CHROME], 'chrome'), CHROME)
  assert.deepEqual(pickBrowser([EDGE, CHROME], 'EDGE'), EDGE, '大小写不敏感')
  assert.deepEqual(pickBrowser([EDGE, CHROME]), EDGE, '不指定就用列表顺序（Edge 优先）')
  assert.equal(pickBrowser([EDGE, CHROME], 'firefox'), null)
  assert.equal(pickBrowser([], 'edge'), null)
})

test('listSystemBrowsers: 本机结果要么为空、要么每项都带 id/name/path', async () => {
  const { listSystemBrowsers } = await import('../lib/browser.js')
  const list = listSystemBrowsers()
  assert.ok(Array.isArray(list))
  for (const entry of list) {
    assert.ok(['edge', 'chrome'].includes(entry.id), entry.id)
    assert.ok(entry.path && entry.name)
    assert.equal(existsSync(entry.path), true, `${entry.path} 应该是真实存在的文件`)
  }
})
