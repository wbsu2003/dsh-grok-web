import z from '@deepseek-ai/schemastery'

/**
 * 插件配置 schema —— 它同时是 DSH 用户设置里本插件的「设置节」，
 * 模型页的「添加提供商」通过 registerConfigurableProviders 指向这一节。
 *
 * 全部字段标 `.volatile()`：Loader 在设置页保存后就地替换这些值，而不重挂
 * 插件 fiber。volatile 字段传进来的是带 `.get()` 的活引用，所以读取前必须
 * 过 unwrapConfig()，并且每次读都重新 unwrap（快照会失效）。
 */
export const Config = z.object({
  authFile: z.string().default('').description('auth.json 路径；留空使用 ~/.dsh/grok-web/auth.json').volatile(),
  proxy: z
    .string()
    .default('auto')
    .description('代理：auto=沿用系统代理环境变量；off=直连；或填 http://127.0.0.1:2081')
    .volatile(),
  model: z
    .string()
    .default('fast')
    .description('默认档位（mgw 服务端名）：fast / auto / build 已实测；expert / heavy 免费账号只回空响应（需 Premium）')
    .volatile(),
  contextWindow: z.number().default(131_072).description('上报给 DSH 的上下文窗口（token）').volatile(),
  defaultMaxTokens: z.number().default(16_384).description('单轮输出上限（token）').volatile(),
  maxPromptChars: z.number().default(200_000).description('序列化提示词的字符上限，超出从最旧历史截断').volatile(),
  idleTimeoutMs: z.number().default(15_000).description('已有正文后的静默兜底（毫秒）').volatile(),
  totalTimeoutMs: z.number().default(300_000).description('单轮总超时（毫秒）').volatile(),
  heartbeatMs: z.number().default(30_000).description('WebSocket 心跳间隔（毫秒）').volatile(),
  connectTimeoutMs: z.number().default(20_000).description('连接与握手超时（毫秒）').volatile(),
  serialToolCalls: z.boolean().default(true).description('一次只跑一个工具调用（网页端不支持并行工具）').volatile(),
  debug: z.boolean().default(false).description('在 DSH 日志里打印每次请求的参数').volatile(),
  userId: z.string().default('').description('手填 x-userid（一般不需要，登录抓取会自动写入）').volatile(),
  userAgent: z.string().default('').description('手填 UA；留空用抓取时记录的浏览器 UA').volatile(),
  /** 手动粘贴 Cookie 的兜底入口：SECRET 角色让设置页与日志都不显明文。 */
  cookie: z.string().role('secret').description('手动 Cookie（不填写时读 authFile）').volatile(),
})
