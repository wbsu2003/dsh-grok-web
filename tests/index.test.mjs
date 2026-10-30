import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, inject, name, Config } from '../lib/index.js'

const MISSING_AUTH_FILE = join(tmpdir(), `dsh-grok-web-absent-${process.pid}.json`)
const WORK_DIR = join(tmpdir(), `dsh-grok-web-entry-${process.pid}`)

/** 宿主 ctx 的最小替身：记录每一次注册，方便断言入口契约。 */
function createCtx({ config = {}, withWebServer = true, entryId = 'dsh-grok-web' } = {}) {
  const seen = { adapters: [], directories: [], routes: [], effects: 0, logs: [], warns: [] }
  const ctx = {
    fiber: { entry: { options: { id: entryId } } },
    llm: {
      registerAdapter(providers, adapter) {
        seen.adapters.push({ providers, adapter })
      },
      registerConfigurableProviders(entries) {
        const record = { published: [entries], disposed: false }
        seen.directories.push(record)
        const handle = () => {
          record.disposed = true
        }
        handle.replace = (next) => record.published.push(next)
        return handle
      },
    },
    logger: {
      info: (message) => seen.logs.push(String(message)),
      warn: (message) => seen.warns.push(String(message)),
    },
    effect(fn) {
      seen.effects += 1
      return fn()
    },
  }
  if (withWebServer) {
    ctx.webServer = {
      register(route) {
        seen.routes.push(route)
        return () => {
          route.disposed = true
        }
      },
    }
  }
  return { ctx, seen, config }
}

test('插件入口: 导出契约', () => {
  assert.equal(name, 'dsh-grok-web')
  assert.deepEqual(inject, ['llm', 'webServer'])
  assert.equal(typeof Config, 'function')
  assert.equal(typeof apply, 'function')
})

test('设置节 schema: 字段齐全、cookie 为 secret、全部 volatile 可热更新', () => {
  const expected = [
    'authFile',
    'proxy',
    'model',
    'contextWindow',
    'defaultMaxTokens',
    'maxPromptChars',
    'idleTimeoutMs',
    'totalTimeoutMs',
    'heartbeatMs',
    'connectTimeoutMs',
    'serialToolCalls',
    'debug',
    'userId',
    'userAgent',
    'cookie',
  ]
  assert.deepEqual(Object.keys(Config.dict).sort(), [...expected].sort())
  for (const key of expected) {
    assert.equal(Config.dict[key].meta.volatile, true, `${key} 必须 volatile，否则保存设置要重挂 fiber`)
    assert.ok(Config.dict[key].meta.description, `${key} 缺少设置页说明`)
  }
  assert.equal(Config.dict.cookie.meta.role, 'secret')
  assert.equal(Config.dict.contextWindow.meta.default, 131_072)
})

test('apply: 注册路由、可配置提供商目录项与面板 API', () => {
  const { ctx, seen } = createCtx()
  apply(ctx, { authFile: MISSING_AUTH_FILE })

  assert.equal(seen.adapters.length, 1)
  assert.deepEqual(seen.adapters[0].providers, ['grok-web'])
  const adapter = seen.adapters[0].adapter
  for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof adapter[method], 'function', method)
  }
  assert.equal(adapter.providerInfo().id, 'grok-web')

  assert.equal(seen.directories.length, 1)
  const [initial] = seen.directories[0].published[0]
  assert.equal(initial.provider, 'grok-web')
  assert.equal(initial.displayName, 'Grok 网页版')
  assert.equal(initial.settingsNs, 'dsh-grok-web')
  assert.deepEqual(initial.settingsPath, [])
  // 无密钥：模型页据此隐藏 API Key 输入框
  assert.deepEqual(initial.nativeAuth, { env: [], oauth: true })

  assert.equal(seen.routes.length, 1)
  assert.equal(seen.routes[0].kind, 'prefix')
  assert.equal(seen.routes[0].path, '/grok-web/api')
  assert.equal(typeof seen.routes[0].handler, 'function')
  assert.equal(seen.effects, 1)
  assert.ok(seen.logs.some((message) => message.includes('已注册 provider "grok-web"')))
})

test('apply: 设置节命名空间跟随实际 fiber 入口 id', () => {
  const { ctx, seen } = createCtx({ entryId: 'dsh-grok-web.dev' })
  apply(ctx, { authFile: MISSING_AUTH_FILE })
  assert.equal(seen.directories[0].published[0][0].settingsNs, 'dsh-grok-web.dev')
})

test('apply: 缺登录态时目录项带可查的 error 文案，登录成功后被清除', async () => {
  mkdirSync(WORK_DIR, { recursive: true })
  try {
    const { ctx, seen } = createCtx()
    apply(ctx, { authFile: MISSING_AUTH_FILE })

    const [withError] = seen.directories[0].published[1]
    assert.ok(withError.error.includes('缺少登录态'), withError.error)
    assert.ok(withError.error.includes('[MISSING_CREDENTIAL]'), withError.error)

    const goodFile = join(WORK_DIR, 'auth.json')
    writeFileSync(
      goodFile,
      JSON.stringify({ version: 1, cookies: [{ name: 'x-userid', value: 'u1234567890', domain: '.grok.com' }] }),
      'utf8',
    )
    const ctx2 = createCtx()
    apply(ctx2.ctx, { authFile: goodFile })
    // published[0] 是初始 entries，登录态有效时不该再 replace 出 error
    const last = ctx2.seen.directories[0].published.at(-1)
    assert.equal(last[0].error, undefined)
    assert.equal(ctx2.seen.directories.length, 1)
  } finally {
    rmSync(WORK_DIR, { recursive: true, force: true })
  }
})

test('apply: 宿主没有 webServer 时降级为警告，路由照旧注册', () => {
  const { ctx, seen } = createCtx({ withWebServer: false })
  assert.doesNotThrow(() => apply(ctx, { authFile: MISSING_AUTH_FILE }))
  assert.equal(seen.adapters.length, 1)
  assert.equal(seen.routes.length, 0)
  assert.ok(seen.warns.some((message) => message.includes('webServer')))
})
