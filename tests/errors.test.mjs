import test from 'node:test'
import assert from 'node:assert/strict'
import { abortError, GrokError, httpErrorCode, parseRetryAfterMs } from '../lib/errors.js'

test('GrokError: code / failure 是实例自有属性且一致（dsh normalize 依赖这个）', () => {
  const cause = new Error('underlying')
  const error = new GrokError('boom', 'SERVER', { status: 503, providerRetryAfterMs: 1_500, cause })
  assert.equal(error.name, 'LlmError')
  assert.equal(error.message, 'boom')
  assert.ok(Object.hasOwn(error, 'code'))
  assert.ok(Object.hasOwn(error, 'failure'))
  assert.equal(error.code, 'SERVER')
  assert.equal(error.failure.code, 'SERVER')
  assert.equal(error.failure.message, 'boom')
  assert.equal(error.failure.status, 503)
  assert.equal(error.failure.providerRetryAfterMs, 1_500)
  assert.equal(error.cause, cause)
})

test('GrokError: 未提供的状态字段不出现', () => {
  const failure = new GrokError('x', 'PROTOCOL').failure
  assert.deepEqual(failure, { message: 'x', code: 'PROTOCOL' })
})

test('abortError 使用 ABORTED', () => {
  assert.equal(abortError().code, 'ABORTED')
  assert.equal(abortError().failure.code, 'ABORTED')
})

test('httpErrorCode 映射', () => {
  assert.equal(httpErrorCode(401), 'AUTH')
  assert.equal(httpErrorCode(403), 'AUTH')
  assert.equal(httpErrorCode(402), 'QUOTA')
  assert.equal(httpErrorCode(429), 'RATE_LIMIT')
  assert.equal(httpErrorCode(500), 'SERVER')
  assert.equal(httpErrorCode(503), 'SERVER')
  assert.equal(httpErrorCode(400), 'PROTOCOL')
  assert.equal(httpErrorCode(0), 'PROTOCOL')
})

test('parseRetryAfterMs: 秒数与 HTTP 日期', () => {
  assert.equal(parseRetryAfterMs('2'), 2_000)
  assert.equal(parseRetryAfterMs('0'), 1_000)
  assert.equal(parseRetryAfterMs(''), undefined)
  assert.equal(parseRetryAfterMs('not-a-date'), undefined)
  const future = new Date(Date.now() + 10_000).toUTCString()
  const parsed = parseRetryAfterMs(future)
  assert.ok(parsed >= 8_000 && parsed <= 12_000, `parsed=${parsed}`)
})
