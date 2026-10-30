/** 简单的异步队列：把回调式事件变成可 await 的流。 */
export function createAsyncQueue() {
  const items = []
  const waiters = []
  let closed = false
  let failure = null

  return {
    push(item) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) waiter.resolve({ value: item, done: false })
      else items.push(item)
    },
    fail(error) {
      if (closed) return
      failure = error
      closed = true
      for (const waiter of waiters.splice(0)) waiter.reject(error)
    },
    close() {
      if (closed) return
      closed = true
      for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
    },
    next() {
      if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false })
      if (failure) return Promise.reject(failure)
      if (closed) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}
