import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/** 最小 React 替身：只验证「渲染函数返回元素」这条契约（React #130 的成因）。 */
function createReactStub() {
  const calls = []
  return {
    calls,
    createElement(type, props, ...children) {
      return { $$typeof: Symbol.for('react.element'), type, props: props ?? {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef(initial) {
      return { current: initial }
    },
  }
}

function load(react) {
  const loaded = []
  const window = {
    __ModuleLoader__: { load: (definition) => loaded.push(definition) },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  // eslint-disable-next-line no-new-func
  new Function('window', SOURCE)(window)
  assert.equal(loaded.length, 1)
  const definition = loaded[0]
  const required = []
  const exports = definition.factory((id) => {
    required.push(id)
    if (id === 'react') return react
    throw new Error(`意外的 require: ${id}`)
  })
  return { definition, exports, required }
}

test('client 包: __ModuleLoader__ 契约与 id', () => {
  const { definition, exports, required } = load(createReactStub())
  assert.equal(definition.id, 'dsh-grok-web')
  assert.equal(typeof definition.factory, 'function')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  assert.deepEqual(required, ['react'])
})

test('client 包: 在 settings.section 注册面板，渲染函数返回 React 元素', () => {
  const react = createReactStub()
  const { exports } = load(react)
  const registered = []
  const injected = []
  let effectLabel = ''
  const ctx = {
    effect(fn, label) {
      effectLabel = String(label ?? '')
      return fn()
    },
    slots: {
      inject(name, factory) {
        injected.push(name)
        return factory()
      },
      register(spec, component) {
        registered.push({ spec, component })
        return () => {}
      },
    },
  }

  assert.doesNotThrow(() => exports.apply(ctx))
  assert.deepEqual(injected, ['settings.section'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].spec.name, 'settings.section')
  assert.equal(registered[0].spec.id, 'dsh-grok-web')
  assert.equal(typeof registered[0].spec.order, 'number')
  assert.equal(registered[0].spec.label(), 'Grok 网页版')
  assert.equal(effectLabel, 'dsh-grok-web: settings panel')

  const element = registered[0].component()
  assert.equal(element.$$typeof, Symbol.for('react.element'), 'register 的第二参必须渲染出元素，否则 React #130')
  assert.equal(typeof element.type, 'function')
  const panel = element.type()
  assert.equal(panel.$$typeof, Symbol.for('react.element'))
  assert.equal(panel.type, 'div')
  assert.ok(Array.isArray(panel.children))

  const labels = []
  const collect = (node) => {
    if (typeof node === 'string' || typeof node === 'number') labels.push(String(node))
    else if (Array.isArray(node)) node.forEach(collect)
    else if (node && node.$$typeof) collect(node.children)
  }
  collect(panel.children)
  for (const label of ['浏览器登录', '从调试端口导入', '探活']) {
    assert.ok(labels.includes(label), `面板缺少按钮：${label}`)
  }
})

test('client 包: 槽位不可用时只降级，不把整个 client fiber 带崩', () => {
  const { exports } = load(createReactStub())
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.map(String).join(' '))
  try {
    assert.doesNotThrow(() =>
      exports.apply({
        effect: (fn) => fn(),
        slots: {
          inject() {
            throw new Error('slot 未注册')
          },
        },
      }),
    )
  } finally {
    console.warn = original
  }
  assert.ok(warnings.some((line) => line.includes('settings.section')))
})
