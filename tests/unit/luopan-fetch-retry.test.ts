import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * 罗盘下载器的**行为**守卫（2026-11-15 审查后补）。
 *
 * luopan-downloader.test.ts 那 8 项是源码字符串断言：改个变量名就红，行为错了却绿。
 * 真实案例——`fetchVideo` 里 403/404 的 `throw` 落在自己的 `catch` 里，被接住后又重试，
 * 实际打了 3 次，而 `expect(background).toContain('attempt >= 2')` 照样通过。
 *
 * 这里把 background.js 放进 vm 沙箱、注入假的 fetch / chrome，直接数请求次数。
 */
const source = readFileSync('assets/browser-extensions/luopan-downloader/background.js', 'utf8').replace(/\r\n/g, '\n')

type FetchLike = (url: string, init?: unknown) => Promise<{ ok: boolean; status: number }>

/** 沙箱里的 setTimeout 立即执行，把 900ms/1800ms 的退避压成 0。 */
function loadFetchVideo(fetchImpl: FetchLike): (url: string) => Promise<unknown> {
  const noop = () => undefined
  const chrome = {
    storage: { local: { set: noop } },
    runtime: {
      lastError: null,
      onConnect: { addListener: noop },
      onMessage: { addListener: noop }
    },
    tabs: { sendMessage: noop }
  }
  const sandbox: Record<string, unknown> = {
    chrome,
    console,
    fetch: fetchImpl,
    setTimeout: (fn: () => void) => { fn(); return 0 },
    clearTimeout: noop,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
  }
  vm.createContext(sandbox)
  vm.runInContext(`${source}\n;globalThis.__fetchVideo = fetchVideo;`, sandbox)
  return sandbox.__fetchVideo as (url: string) => Promise<unknown>
}

/** 记录每个状态码被请求了几次。 */
function countingFetch(statuses: number[]): { calls: () => number; impl: FetchLike } {
  let calls = 0
  return {
    calls: () => calls,
    impl: async () => {
      const status = statuses[Math.min(calls, statuses.length - 1)]
      calls++
      return { ok: status >= 200 && status < 300, status }
    }
  }
}

describe('罗盘下载器 fetchVideo：只对可恢复错误重试', () => {
  it('403 只请求 1 次就失败（签名过期不重试）', async () => {
    const counter = countingFetch([403])
    const fetchVideo = loadFetchVideo(counter.impl)
    await expect(fetchVideo('https://cdn/x.mp4')).rejects.toThrow(/已过期/)
    expect(counter.calls()).toBe(1)
  })

  it('404 只请求 1 次就失败', async () => {
    const counter = countingFetch([404])
    const fetchVideo = loadFetchVideo(counter.impl)
    await expect(fetchVideo('https://cdn/x.mp4')).rejects.toThrow(/已过期/)
    expect(counter.calls()).toBe(1)
  })

  it('500 连续 3 次后放弃，共请求 3 次', async () => {
    const counter = countingFetch([500])
    const fetchVideo = loadFetchVideo(counter.impl)
    await expect(fetchVideo('https://cdn/x.mp4')).rejects.toThrow(/服务端繁忙/)
    expect(counter.calls()).toBe(3)
  })

  it('429 后成功：共请求 2 次并返回响应', async () => {
    const counter = countingFetch([429, 200])
    const fetchVideo = loadFetchVideo(counter.impl)
    const res = (await fetchVideo('https://cdn/x.mp4')) as { status: number }
    expect(res.status).toBe(200)
    expect(counter.calls()).toBe(2)
  })

  it('网络异常重试后成功：共请求 3 次', async () => {
    let calls = 0
    const fetchVideo = loadFetchVideo(async () => {
      calls++
      if (calls <= 2) throw new Error('ECONNRESET')
      return { ok: true, status: 200 }
    })
    const res = (await fetchVideo('https://cdn/x.mp4')) as { status: number }
    expect(res.status).toBe(200)
    expect(calls).toBe(3)
  })

  it('网络异常连续 3 次：抛网络错误本身，不是 HTTP 文案', async () => {
    const fetchVideo = loadFetchVideo(async () => { throw new Error('ECONNRESET') })
    await expect(fetchVideo('https://cdn/x.mp4')).rejects.toThrow(/ECONNRESET/)
  })
})
