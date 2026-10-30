/**
 * 统一错误类型。
 *
 * dsh-llm 的 `normalizeLlmFailure` 只信任**自有**的 `failure` 字段，并且要求
 * `failure.code === error.code`；缺一个就整条降级成 UNKNOWN。所以 code / failure
 * 必须写成实例自有属性（不能只靠 getter 或原型链）。
 */
export class GrokError extends Error {
  constructor(message, code, options = {}) {
    super(String(message))
    this.name = 'LlmError'
    this.code = String(code)
    this.failure = {
      message: String(message),
      code: String(code),
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.providerRetryAfterMs !== undefined
        ? { providerRetryAfterMs: options.providerRetryAfterMs }
        : {}),
    }
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export function abortError(message = 'grok-web 请求被调用方取消') {
  return new GrokError(message, 'ABORTED')
}

/** 把 HTTP 状态映射为稳定错误码（对齐 dsh-llm 默认可重试码表）。 */
export function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 402) return 'QUOTA'
  if (status >= 500) return 'SERVER'
  return 'PROTOCOL'
}

export function parseRetryAfterMs(raw) {
  if (!raw) return undefined
  const text = String(raw).trim()
  if (/^\d+$/.test(text)) return Math.max(1000, Number(text) * 1000)
  const parsed = Date.parse(text)
  if (!Number.isNaN(parsed)) return Math.max(1000, parsed - Date.now())
  return undefined
}
