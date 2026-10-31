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

/** 只把面板渲染出来，用于断言元素形状（不校验注册契约）。 */
function mountPanel(react) {
  const { exports } = load(react)
  let panel
  exports.apply({
    effect: (fn) => fn(),
    slots: {
      inject: (name, factory) => factory(),
      register: (spec, component) => {
        panel = component().type()
        return () => {}
      },
    },
  })
  return panel
}

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit))
  if (node && node.$$typeof) {
    visit(node)
    return walk(node.children, visit)
  }
  return undefined
}

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
  // status 还没拉到时（browsers 为空）也要有一组能点的按钮，不能只剩空壳。
  for (const label of ['用 浏览器 登录', '用我的默认浏览器登录', '从调试端口导入', '探活', '保存并验证']) {
    assert.ok(labels.includes(label), `面板缺少按钮：${label}`)
  }
})

test('client 包: Cookie 框是密码型输入，空内容时不给提交机会', () => {
  const panel = mountPanel(createReactStub())
  const nodes = []
  walk(panel, (node) => nodes.push(node))
  const cookie = nodes.find((node) => node.type === 'input' && node.props['aria-label'] === 'Cookie')
  assert.ok(cookie, '面板要有 Cookie 输入框')
  assert.equal(cookie.props.type, 'password', '粘贴的是登录态明文，不能在界面上显示出来')
  const save = nodes.find((node) => node.type === 'button' && node.children.includes('保存并验证'))
  assert.ok(save, '要有「保存并验证」按钮')
  assert.equal(save.props.disabled, true, 'Cookie 还空着时按钮必须不可点')
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
