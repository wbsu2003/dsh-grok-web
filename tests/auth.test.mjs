import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  describeAuth,
  findCookie,
  isGrokDomain,
  maskValue,
  parseCookieHeader,
  readAuth,
  resolveAuthFile,
  saveAuthFile,
} from '../lib/auth.js'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grok-auth-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const SAVED_COOKIES = [
  { name: 'sso', value: 'sso-secret', domain: '.grok.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86_400, httpOnly: true, secure: true },
  { name: 'x-userid', value: 'user-42', domain: '.grok.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86_400 },
  { name: 'old', value: 'legacy', domain: '.grok.com', path: '/', expires: Math.floor(Date.now() / 1000) - 100 },
  { name: 'other', value: 'nope', domain: '.example.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86_400 },
]

test('parseCookieHeader / findCookie / isGrokDomain', () => {
  assert.deepEqual(parseCookieHeader('Cookie: a=1; b=2'), ['a=1', 'b=2'])
  assert.deepEqual(parseCookieHeader('  '), [])
  assert.equal(findCookie(['a=1', 'x-userid=u9'], 'x-userid'), 'u9')
  assert.equal(findCookie(['a=1'], 'missing'), '')
  assert.equal(isGrokDomain('.grok.com'), true)
  assert.equal(isGrokDomain('grok.com'), true)
  assert.equal(isGrokDomain('api.grok.com'), true)
  assert.equal(isGrokDomain('evilgrok.com'), false)
  assert.equal(isGrokDomain('example.com'), false)
})

test('readAuth: 配置 cookie 优先，uid 从 x-userid 取', () => {
  const auth = readAuth({ cookie: 'x-userid=u1; sso=s1', userId: '', userAgent: '' })
  assert.equal(auth.source, 'config')
  assert.equal(auth.userId, 'u1')
  assert.equal(auth.cookieHeader, 'x-userid=u1; sso=s1')
  assert.ok(auth.userAgent.includes('Mozilla/5.0'))
  assert.deepEqual(auth.expiredCookies, [])
})

test('readAuth: 配置 cookie 缺 x-userid 时报 MISSING_CREDENTIAL', () => {
  assert.throws(() => readAuth({ cookie: 'sso=s1' }), (error) => error.code === 'MISSING_CREDENTIAL')
})

test('readAuth: 文件模式读取 cookie 记录，过滤非 grok 域并列出过期项', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'auth.json')
  saveAuthFile(file, {
    userId: 'user-42',
    userAgent: 'UA-test',
    capturedAt: '2026-10-01T00:00:00.000Z',
    cookies: SAVED_COOKIES,
  })

  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.provider, 'grok-web')
  assert.equal(raw.version, 1)
  assert.equal(raw.cookies.length, 4)

  const auth = readAuth({ authFile: file })
  assert.equal(auth.source, 'file')
  assert.equal(auth.file, file)
  assert.equal(auth.userId, 'user-42')
  assert.equal(auth.userAgent, 'UA-test')
  assert.ok(auth.cookieHeader.includes('sso=sso-secret'))
  assert.ok(auth.cookieHeader.includes('x-userid=user-42'))
  assert.ok(!auth.cookieHeader.includes('nope'))
  assert.deepEqual(auth.expiredCookies, ['old'])
})

test('readAuth: 文件里的 cookieHeader 字符串也可用', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'auth.json')
  writeFileSync(
    file,
    JSON.stringify({ userId: 'from-header', cookieHeader: 'sso=x; x-userid=from-cookie', userAgent: 'UA' }),
    'utf8',
  )
  const auth = readAuth({ authFile: file })
  assert.equal(auth.userId, 'from-cookie')
  assert.equal(auth.cookieHeader, 'sso=x; x-userid=from-cookie')
})

test('readAuth: 文件不存在 / 坏 JSON / 无 cookie 都报 MISSING_CREDENTIAL', (t) => {
  const dir = tempDir(t)
  assert.throws(() => readAuth({ authFile: join(dir, 'missing.json') }), (error) => error.code === 'MISSING_CREDENTIAL')

  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ not json', 'utf8')
  assert.throws(() => readAuth({ authFile: broken }), (error) => error.code === 'MISSING_CREDENTIAL')

  const empty = join(dir, 'empty.json')
  writeFileSync(empty, JSON.stringify({ cookies: [] }), 'utf8')
  assert.throws(() => readAuth({ authFile: empty }), (error) => error.code === 'MISSING_CREDENTIAL')
})

test('resolveAuthFile: 相对路径按当前目录解析，空值走默认位置', () => {
  assert.equal(resolveAuthFile('relative/auth.json'), resolve('relative/auth.json'))
  assert.ok(isAbsolute(resolveAuthFile('relative/auth.json')))
  assert.ok(resolveAuthFile('').endsWith(join('grok-web', 'auth.json')))
})

test('maskValue / describeAuth 不暴露原始凭证', () => {
  assert.equal(maskValue(''), '')
  assert.equal(maskValue('short'), 'short…')
  const masked = maskValue('abcdefghijklmno')
  assert.ok(!masked.includes('abcdefghijklmno'))
  assert.ok(masked.includes('…'))

  const described = describeAuth({
    source: 'file',
    userId: 'user-123456789',
    file: 'C:/secret/auth.json',
    capturedAt: '2026-10-01T00:00:00.000Z',
    expiredCookies: ['old'],
  })
  assert.equal(described.loggedIn, true)
  assert.ok(described.userId.includes('…'))
  assert.deepEqual(described.expiredCookies, ['old'])
  assert.deepEqual(describeAuth(undefined), { loggedIn: false })
})
