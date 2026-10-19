import { describe, expect, it } from 'vitest'
import { describeAiFailure } from '../../apps/desktop/src/main/services/ai-failure-text'

describe('describeAiFailure：AI 失败文案（主进程 → 界面）', () => {
  it('未配置类错误原样透传（可执行的中文提示不能被重映射成"凭据被拒绝"）', () => {
    const text = '既没有单独的"生图文本 API"，也没有可用的文本 API；请在「设置中心 → AI 配置」里配置其中一套'
    expect(describeAiFailure({ code: 'AI_IMAGE_TEXT_NOT_CONFIGURED', message: text }))
      .toEqual({ code: 'AI_IMAGE_TEXT_NOT_CONFIGURED', message: text })
    expect(describeAiFailure({ code: 'AI_NOT_CONFIGURED', message: '未配置大模型 API Key（设置 → AI 配置）' }))
      .toEqual({ code: 'AI_NOT_CONFIGURED', message: '未配置大模型 API Key（设置 → AI 配置）' })
    // 没有 message 时也要给出可执行的兜底，而不是空串
    expect(describeAiFailure({ code: 'AI_IMAGE_NOT_CONFIGURED' }).message).toContain('设置中心')
  })

  it('网络不可达 → 中文可执行提示，且保留截断后的原始摘要', () => {
    expect(describeAiFailure(new TypeError('fetch failed')).message)
      .toMatch(/^连不上 AI 接口：请到设置中心核对接口地址与网络（原始错误：fetch failed）$/)
    expect(describeAiFailure(new Error('connect ECONNREFUSED 127.0.0.1:9392')).message).toContain('连不上 AI 接口')
    expect(describeAiFailure({ code: 'AI_REQUEST_FAILED', message: 'getaddrinfo ENOTFOUND api.example.com' }).message).toContain('连不上 AI 接口')
  })

  it('超时 → 中文提示（含 AbortError 这种底层名）', () => {
    expect(describeAiFailure(new Error('The operation was aborted due to timeout')).message).toContain('响应超时')
    expect(describeAiFailure({ message: 'request ETIMEDOUT' }).message).toContain('稍后重试或调大设置里的超时时间')
  })

  it('凭据被拒 / 限流 / 服务端错误各自映射', () => {
    expect(describeAiFailure({ message: 'HTTP 401 Unauthorized' }).message).toContain('检查 API Key 是否有效')
    expect(describeAiFailure({ message: 'Incorrect API key provided' }).message).toContain('检查 API Key 是否有效')
    expect(describeAiFailure({ message: '429 Too Many Requests' }).message).toContain('限流（429）')
    expect(describeAiFailure({ message: 'rate limit exceeded' }).message).toContain('限流（429）')
    expect(describeAiFailure({ message: '502 Bad Gateway' }).message).toContain('服务端错误')
    expect(describeAiFailure({ message: 'Internal Server Error 500' }).message).toContain('服务端错误')
  })

  it('已经是中文可读文案的错误原样透传（配置/入参类请求根本没发出去，不该说成"AI 请求失败"）', () => {
    // 2026-10-18 独立复验 F1：这类文案冠上「AI 请求失败」会误导用户去重试
    expect(describeAiFailure({ code: 'AI_BAD_ENDPOINT', message: '接口地址须为 https://（仅 127.0.0.1 / localhost 允许 http://）' }))
      .toEqual({ code: 'AI_BAD_ENDPOINT', message: '接口地址须为 https://（仅 127.0.0.1 / localhost 允许 http://）' })
    expect(describeAiFailure({ code: 'AI_BAD_INPUT', message: '第 1 个参考图片类型不受支持' }).message).toBe('第 1 个参考图片类型不受支持')
    expect(describeAiFailure({ code: 'AI_EMPTY_OUTPUT', message: '生图文本模型返回了空内容' }).message).toBe('生图文本模型返回了空内容')
    // 非 AI 域的显式错误码：走中性框（不冠 AI 语义），见下一条用例
    expect(describeAiFailure({ code: 'STORE_NOT_FOUND', message: '店铺不存在' }))
      .toEqual({ code: 'STORE_NOT_FOUND', message: '操作失败：店铺不存在' })
  })

  it('URL 端口 / 无上下文的裸三位数不会被误判成 HTTP 状态码（复验 F1 + 残留 1）', () => {
    const url = describeAiFailure({ message: 'POST http://127.0.0.1:500/v1/chat/completions failed' }).message
    expect(url).not.toContain('服务端错误')
    expect(url).toBe('AI 请求失败：POST http://127.0.0.1:500/v1/chat/completions failed')
    // `bytes=500` / `retry after 500 ms` 不是 HTTP 状态码
    expect(describeAiFailure({ message: 'response body exceeds bytes=500 limit' }).message).not.toContain('服务端错误')
    expect(describeAiFailure({ message: 'retry after 500 ms' }).message).not.toContain('服务端错误')
    // 真正的状态码上下文仍然要命中（含带版本号的 HTTP/1.1 —— 复验 round4 F-1 曾指出这条声明不成立）
    expect(describeAiFailure({ message: 'HTTP 500 Internal Server Error' }).message).toContain('服务端错误')
    expect(describeAiFailure({ message: 'HTTP/1.1 503' }).message).toContain('服务端错误')
    expect(describeAiFailure({ message: 'HTTP/2 502' }).message).toContain('服务端错误')
    expect(describeAiFailure({ message: 'upstream returned 503' }).message).toContain('服务端错误')
    expect(describeAiFailure({ message: 'status: 502' }).message).toContain('服务端错误')
    expect(describeAiFailure({ message: 'statusCode 502' }).message).toContain('服务端错误')
    // 「有上下文」才算：got 500 from upstream 这类无状态码语境的裸数字不判 5xx
    expect(describeAiFailure({ message: 'got 500 from upstream' }).message).not.toContain('服务端错误')
    // 端口形态（:5000 / :4010）同样不能命中
    expect(describeAiFailure({ message: 'GET http://127.0.0.1:5000/v1/models failed' }).message).not.toContain('服务端错误')
    expect(describeAiFailure({ message: 'GET http://127.0.0.1:4010/v1/models failed' }).message).not.toContain('凭据')
  })

  it('显式非 AI 错误码不冠 AI 语义（复验残留 3）', () => {
    expect(describeAiFailure({ code: 'STORE_NOT_FOUND', message: 'store not found' }))
      .toEqual({ code: 'STORE_NOT_FOUND', message: '操作失败：store not found' })
    expect(describeAiFailure({ code: 'SQLITE_BUSY', message: 'database is locked' }).message).toBe('操作失败：database is locked')
    // AI 域的码不受影响
    expect(describeAiFailure({ code: 'AI_REQUEST_FAILED', message: 'database is locked' }).message).toBe('AI 请求失败：database is locked')
  })

  it('AGENT_BUDGET_* 属于 AI 域：给指向日预算的文案，不能框成中性「操作失败」（复验 round4 F-2）', () => {
    const blocked = describeAiFailure({ code: 'AGENT_BUDGET_BLOCKED', message: '达到日预算边界，已停止调用模型' })
    expect(blocked.code).toBe('AGENT_BUDGET_BLOCKED')
    expect(blocked.message).toContain('Agent 日预算挡住了这次模型调用')
    expect(blocked.message).toContain('达到日预算边界')
    expect(blocked.message).not.toContain('操作失败')
    expect(describeAiFailure({ code: 'AGENT_BUDGET_UNENFORCEABLE', message: '没有可用的预算配置' }).message)
      .toContain('Agent 日预算挡住了这次模型调用')
    expect(describeAiFailure({ code: 'AGENT_BUDGET_BLOCKED' }).message).toContain('设置中心')
  })

  it('中文可读文案原样透传，但**同样截断**（复验残留 2：截断纪律不能只对英文生效）', () => {
    const longChinese = `上游返回了很长的中文错误体：${'字'.repeat(300)}`
    const message = describeAiFailure({ code: 'AI_REQUEST_FAILED', message: longChinese }).message
    expect(message.length).toBeLessThan(140)
    expect(message.endsWith('…')).toBe(true)
    expect(message.startsWith('上游返回了很长的中文错误体：')).toBe(true)
  })

  it('未知原因走兜底：中文原样透传、英文带前缀且不吞信息', () => {
    // 中文（主进程自己写的可执行文案）不再二次包裹
    expect(describeAiFailure(new Error('模型返回了无法解析的结构')).message).toBe('模型返回了无法解析的结构')
    expect(describeAiFailure({ code: 'AI_REQUEST_FAILED', message: 'AI_REQUEST_FAILED: 连接被拒绝' }).message)
      .toBe('连接被拒绝')
    // 英文底层串才需要兜底前缀，且剥掉 CODE 前缀
    expect(describeAiFailure({ code: 'AI_REQUEST_FAILED', message: 'AI_REQUEST_FAILED: unexpected token <' }).message)
      .toBe('AI 请求失败：unexpected token <')
  })

  it('畸形输入不抛异常、输出稳定', () => {
    for (const input of [null, undefined, '', 0, false, [], {}, Symbol('x'), () => {}]) {
      const result = describeAiFailure(input)
      expect(result.code).toBe('AI_REQUEST_FAILED')
      expect(result.message.length).toBeGreaterThan(0)
    }
    // 非大写 code 不当作 code 使用
    expect(describeAiFailure({ code: 'lowercase', message: 'boom' }).code).toBe('AI_REQUEST_FAILED')
    expect(describeAiFailure('AI_BOOM').code).toBe('AI_REQUEST_FAILED')
  })

  it('超长摘要被截断，避免把整段 HTML/堆栈甩到界面', () => {
    const message = describeAiFailure({ message: 'x'.repeat(500) }).message
    expect(message).toContain('…')
    expect(message.length).toBeLessThan(140)
  })
})
