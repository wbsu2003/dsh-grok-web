import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULTS,
  MODEL_ID,
  TIERS,
  defaultTier,
  findTier,
  listableTiers,
  modelInfo,
  normalizeConfig,
  resolvedModelInfo,
  unwrapConfig,
} from '../lib/config.js'

test('normalizeConfig: 默认值', () => {
  const config = normalizeConfig()
  assert.equal(config.model, 'fast')
  assert.equal(config.proxy, 'auto')
  assert.equal(config.contextWindow, 131_072)
  assert.equal(config.defaultMaxTokens, 16_384)
  assert.equal(config.maxPromptChars, 200_000)
  assert.equal(config.idleTimeoutMs, 15_000)
  assert.equal(config.totalTimeoutMs, 300_000)
  assert.equal(config.serialToolCalls, true)
  assert.equal(config.debug, false)
  assert.ok(config.authFile.endsWith('auth.json'))
})

test('normalizeConfig: 数值钳制到安全区间', () => {
  const low = normalizeConfig({
    contextWindow: 1,
    defaultMaxTokens: 1,
    maxPromptChars: 1,
    idleTimeoutMs: 1,
    totalTimeoutMs: 1,
    heartbeatMs: 1,
    connectTimeoutMs: 1,
  })
  assert.equal(low.contextWindow, 8_192)
  assert.equal(low.defaultMaxTokens, 256)
  assert.equal(low.maxPromptChars, 20_000)
  assert.equal(low.idleTimeoutMs, 2_000)
  assert.equal(low.totalTimeoutMs, 10_000)
  assert.equal(low.heartbeatMs, 5_000)
  assert.equal(low.connectTimeoutMs, 3_000)

  const high = normalizeConfig({
    contextWindow: 99_000_000,
    defaultMaxTokens: 99_000_000,
    maxPromptChars: 99_000_000,
    idleTimeoutMs: 99_000_000,
    totalTimeoutMs: 99_000_000,
    heartbeatMs: 99_000_000,
    connectTimeoutMs: 99_000_000,
  })
  assert.equal(high.contextWindow, 2_000_000)
  assert.equal(high.defaultMaxTokens, 131_072)
  assert.equal(high.maxPromptChars, 1_500_000)
  assert.equal(high.idleTimeoutMs, 300_000)
  assert.equal(high.totalTimeoutMs, 1_800_000)
  assert.equal(high.heartbeatMs, 120_000)
  assert.equal(high.connectTimeoutMs, 120_000)
})

test('normalizeConfig: 非数值回落默认，布尔只认显式值', () => {
  const config = normalizeConfig({
    idleTimeoutMs: 'abc',
    serialToolCalls: false,
    debug: 'yes',
    proxy: false,
  })
  assert.equal(config.idleTimeoutMs, DEFAULTS.idleTimeoutMs)
  assert.equal(config.serialToolCalls, false)
  assert.equal(config.debug, false)
  assert.equal(config.proxy, false)
})

test('modelInfo / resolvedModelInfo 形状', () => {
  const config = normalizeConfig({ model: 'fast' })
  const info = modelInfo(config, 'grok-web')
  assert.equal(info.id, MODEL_ID)
  assert.equal(info.provider, 'grok-web')
  assert.ok(info.name.includes('Grok'))
  assert.ok(info.name.includes('Fast'))
  assert.deepEqual(info.inputModalities, ['text'])

  const resolved = resolvedModelInfo(config, 'grok-web')
  assert.deepEqual(resolved.context, { contextWindow: 131_072 })
  assert.equal(resolved.defaultMaxTokens, 16_384)
})

test('档位表: 只有实测过的档位默认对外，配置能覆盖默认档', () => {
  assert.deepEqual(
    TIERS.map((tier) => tier.model),
    ['fast', 'auto', 'build', 'expert', 'heavy'],
  )
  assert.deepEqual(
    listableTiers(normalizeConfig({})).map((tier) => tier.id),
    ['grok-web', 'grok-web-auto', 'grok-web-build'],
  )
  assert.equal(findTier('grok-web-heavy').model, 'heavy')
  assert.equal(findTier('auto').id, 'grok-web-auto')
  assert.equal(findTier('  '), undefined)
  assert.equal(findTier('nope'), undefined)

  assert.equal(defaultTier(normalizeConfig({ model: 'expert' })).id, 'grok-web-expert')
  assert.deepEqual(
    listableTiers(normalizeConfig({ model: 'expert' })).map((tier) => tier.id),
    ['grok-web', 'grok-web-auto', 'grok-web-build', 'grok-web-expert'],
  )
  // 没登记的档位名也留手工试错通道：id 用 grok-web-<name>
  const custom = defaultTier(normalizeConfig({ model: 'ultra' }))
  assert.equal(custom.model, 'ultra')
  assert.equal(custom.id, MODEL_ID, '未登记的档位名沿用默认 id')
})

test('unwrapConfig: 摊平 volatile 活引用，且每次读都取最新值', () => {
  let value = 'expert'
  const live = { model: { get: () => value }, debug: true, cookie: undefined }
  assert.deepEqual(unwrapConfig(live), { model: 'expert', debug: true, cookie: undefined })
  value = 'fast'
  assert.equal(unwrapConfig(live).model, 'fast', '活引用必须就地反映设置页保存后的新值')
  assert.deepEqual(unwrapConfig(null), {})
  assert.deepEqual(unwrapConfig(undefined), {})
  assert.deepEqual(unwrapConfig('nope'), {})
})
