import { createAdapter, PROVIDER } from './adapter.js'
import { Config } from './settings.js'
import { API_PREFIX, DISPLAY_NAME, createApiHandler } from './api.js'
import { readAuth } from './auth.js'
import { unwrapConfig } from './config.js'

export const name = 'dsh-grok-web'
// webServer 只服务于设置页面板；拿不到它的宿主（纯 headless）会在下面降级。
export const inject = ['llm', 'webServer']
export { Config }

const NO_AUTH_HINT = '缺少登录态：在「设置 → Grok 网页版」面板点「浏览器登录」，或运行 node scripts/login.mjs'

/** 登录态摘要压成一行，供提供商目录当 error 文案显示。 */
function authProblem(config) {
  try {
    readAuth(unwrapConfig(config))
    return ''
  } catch (error) {
    const code = typeof error?.code === 'string' ? `[${error.code}] ` : ''
    return `${NO_AUTH_HINT}（${code}${String(error?.message ?? error).split('\n')[0]}）`
  }
}

/**
 * Cordis 插件入口：
 *  1) 注册 `grok-web` 路由（与插件 fiber 绑定，热重载即净）
 *  2) 把自己声明成「可配置提供商」，模型页的添加提供商里能看到 Grok
 *  3) 挂 /grok-web/api/* 给设置页面板用（登录抓取、导入、探活）
 *
 * config 里的字段是 volatile 活引用，所以一律按需 unwrap，不缓存快照。
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? {}
  const adapter = createAdapter({ config, logger })
  ctx.llm.registerAdapter([PROVIDER], adapter)

  const settingsNs = ctx.fiber?.entry?.options?.id ?? 'dsh-grok-web'
  const entry = {
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    settingsNs,
    settingsPath: [],
    // 无密钥、走浏览器登录态：告诉模型页不要渲染 API Key 输入框
    nativeAuth: { env: [], oauth: true },
  }
  const directory = ctx.llm.registerConfigurableProviders([entry])

  let reported = null
  const publish = () => {
    const problem = authProblem(config)
    if (problem === reported) return
    reported = problem
    directory.replace([problem ? { ...entry, error: problem } : entry])
  }
  publish()

  if (typeof ctx.webServer?.register === 'function') {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: createApiHandler({
          resolveConfig: () => config,
          logger,
          onChanged: publish,
        }),
      }),
    )
  } else {
    logger.warn?.('dsh-grok-web: 宿主没有 webServer，设置页面板不可用（生成请求不受影响）')
  }

  logger.info?.(`dsh-grok-web: 已注册 provider "${PROVIDER}"（设置节 ${settingsNs}，面板 API ${API_PREFIX}）`)
}
