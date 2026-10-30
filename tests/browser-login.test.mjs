import test from 'node:test'
import assert from 'node:assert/strict'
import { browserLogin } from '../lib/browser-login.js'

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
