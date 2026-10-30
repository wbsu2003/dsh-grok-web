import test from 'node:test'
import assert from 'node:assert/strict'
import { proxyParts, resolveProxy, shouldBypassProxy } from '../lib/proxy.js'

const NO_ENV = {}

test('shouldBypassProxy: 通配、域名后缀、端口与 IP', () => {
  assert.equal(shouldBypassProxy('*', 'grok.com', 443), true)
  assert.equal(shouldBypassProxy('.grok.com', 'api.grok.com', 443), true)
  assert.equal(shouldBypassProxy('grok.com', 'grok.com', 443), true)
  assert.equal(shouldBypassProxy('grok.com', 'evilgrok.com', 443), false)
  assert.equal(shouldBypassProxy('grok.com:443', 'grok.com', 443), true)
  assert.equal(shouldBypassProxy('grok.com:8443', 'grok.com', 443), false)
  assert.equal(shouldBypassProxy('127.0.0.1,localhost', '127.0.0.1', 443), true)
  assert.equal(shouldBypassProxy('[::1]', '::1', 443), true)
  assert.equal(shouldBypassProxy('', 'grok.com', 443), false)
  assert.equal(shouldBypassProxy(undefined, 'grok.com', 443), false)
})

test('resolveProxy: 关闭配置优先于环境变量', () => {
  const env = { HTTPS_PROXY: 'http://env-proxy:3128' }
  assert.deepEqual(resolveProxy({ configProxy: false, env, platform: 'linux' }), { url: '', source: 'direct' })
  assert.deepEqual(resolveProxy({ configProxy: 'off', env, platform: 'linux' }), { url: '', source: 'direct' })
  assert.deepEqual(resolveProxy({ configProxy: 'direct', env, platform: 'linux' }), { url: '', source: 'direct' })
})

test('resolveProxy: 显式配置的代理（含缺省协议）', () => {
  assert.deepEqual(resolveProxy({ configProxy: '127.0.0.1:2081', env: NO_ENV, platform: 'linux' }), {
    url: 'http://127.0.0.1:2081/',
    source: 'config',
  })
  assert.deepEqual(resolveProxy({ configProxy: 'http://user:pass@proxy:8080', env: NO_ENV, platform: 'linux' }), {
    url: 'http://user:pass@proxy:8080/',
    source: 'config',
  })
})

test('resolveProxy: SOCKS 明确报错而不是静默直连', () => {
  assert.throws(
    () => resolveProxy({ configProxy: 'socks5://127.0.0.1:1080', env: NO_ENV, platform: 'linux' }),
    /不支持的代理协议/,
  )
})

test('resolveProxy: 环境变量按目标协议选择 HTTPS_PROXY / HTTP_PROXY', () => {
  assert.deepEqual(
    resolveProxy({ env: { HTTPS_PROXY: 'http://env-proxy:3128' }, platform: 'linux', targetUrl: 'wss://grok.com/' }),
    { url: 'http://env-proxy:3128/', source: 'env' },
  )
  assert.deepEqual(
    resolveProxy({ env: { HTTP_PROXY: 'http://plain:3128' }, platform: 'linux', targetUrl: 'wss://grok.com/' }),
    { url: '', source: 'direct' },
  )
  assert.deepEqual(
    resolveProxy({ env: { HTTP_PROXY: 'http://plain:3128' }, platform: 'linux', targetUrl: 'ws://grok.com/' }),
    { url: 'http://plain:3128/', source: 'env' },
  )
})

test('resolveProxy: NO_PROXY 命中时不走代理', () => {
  assert.deepEqual(
    resolveProxy({
      configProxy: 'http://proxy:8080',
      env: { NO_PROXY: 'grok.com' },
      platform: 'linux',
      targetUrl: 'wss://grok.com/',
    }),
    { url: '', source: 'bypass' },
  )
  assert.deepEqual(
    resolveProxy({
      configProxy: 'http://proxy:8080',
      env: { NO_PROXY: 'grok.com:8443' },
      platform: 'linux',
      targetUrl: 'wss://grok.com/',
    }),
    { url: 'http://proxy:8080/', source: 'config' },
  )
})

test('resolveProxy: Windows 系统代理（注入 registryReader）', () => {
  assert.deepEqual(
    resolveProxy({
      env: NO_ENV,
      platform: 'win32',
      registryReader: () => 'http://registry-proxy:8888',
    }),
    { url: 'http://registry-proxy:8888/', source: 'registry' },
  )
  assert.deepEqual(
    resolveProxy({ env: NO_ENV, platform: 'win32', registryReader: () => '' }),
    { url: '', source: 'direct' },
  )
})

test('proxyParts: Basic 认证、默认端口与协议校验', () => {
  assert.equal(proxyParts(''), null)
  assert.deepEqual(proxyParts('http://127.0.0.1:8080'), {
    host: '127.0.0.1',
    port: 8080,
    secure: false,
    authorization: '',
  })
  assert.deepEqual(proxyParts('https://proxy.example.com'), {
    host: 'proxy.example.com',
    port: 443,
    secure: true,
    authorization: '',
  })
  const authenticated = proxyParts('http://user:p%40ss@127.0.0.1:8080')
  assert.equal(authenticated.authorization, `Basic ${Buffer.from('user:p@ss', 'utf8').toString('base64')}`)
  assert.throws(() => proxyParts('socks5://127.0.0.1:1080'), /不支持的代理协议/)
})
