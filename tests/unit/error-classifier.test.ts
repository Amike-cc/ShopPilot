import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { classifyTaskError } from '../../apps/desktop/src/main/tasks/error-classifier'

/**
 * 任务失败错误码分类的单测。
 *
 * 这里防的是一类**静默**缺陷：引擎抛出某个错误码，分类器不认识，于是
 * task_runs.error_code 落成 INTERNAL_ERROR。界面直接把这一列展示给用户，
 * 结果"平台明确拒绝了这次提交"被显示成"内部错误"——用户会以为软件坏了，
 * 甚至因为看不到真实原因而重复提交。
 *
 * 实测漏掉过 5 个（TASK_TEXT_PRESENT / TASK_TARGET_COVERED / CAPTURE_EMPTY /
 * TASK_INVALID_STEP / TASK_BAD_STATE），根因是"白名单只能靠人记得同步"。
 * 现在分类器改成"已知码优先 + 通用兜底"，下面覆盖两类白名单法根本解决不了的情况：
 *   ① 由**步骤参数**指定的自定义错误码（源码里扫不到）；
 *   ② loop 包装后的内层真实码（外壳码没信息，必须往下取）。
 */
const ROOT = path.join(__dirname, '../..')
const RUNNER_SRC = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/tasks/task-runner.ts'), 'utf8')

describe('任务错误码分类', () => {
  it('能识别引擎实际会抛出的错误码（含此前被吞成 INTERNAL_ERROR 的几个）', () => {
    const cases: Array<[string, string]> = [
      ['TASK_TEXT_PRESENT: 页面上出现了「部分邀约发送失败」——平台已明确拒绝', 'TASK_TEXT_PRESENT'],
      ['TASK_TARGET_COVERED: 「确认发送」被弹层遮挡，点不到', 'TASK_TARGET_COVERED'],
      ['CAPTURE_EMPTY: 页面当前不可见（视口未渲染），无法截图', 'CAPTURE_EMPTY'],
      ['TASK_INVALID_STEP: 未知步骤类型 loopx', 'TASK_INVALID_STEP'],
      ['TASK_BAD_STATE: failed 状态不可恢复', 'TASK_BAD_STATE'],
      ['TASK_TIMEOUT: clickAll 超过 120000ms', 'TASK_TIMEOUT'],
      ['TASK_SELECTION_SHORTFALL: 只勾中 3 位，少于要求的 40 位', 'TASK_SELECTION_SHORTFALL'],
      ['TASK_QUOTA_EXCEEDED: 数值不足——页面显示「今日剩余 0」', 'TASK_QUOTA_EXCEEDED'],
      ['BROWSER_CLOSED: 店铺浏览器已关闭', 'BROWSER_CLOSED'],
      ['AI_TIMEOUT: 模型响应超时', 'AI_TIMEOUT'],
      ['TASK_SELECTOR_CHANGED: 未找到元素 #x', 'TASK_SELECTOR_CHANGED'],
      ['NAVIGATION_BLOCKED: 仅允许 http/https', 'NAVIGATION_BLOCKED'],
      // AI 的两条空内容错误统一归到 AI_EMPTY_OUTPUT
      ['AI_EMPTY_SOURCE: 页面没取到商品信息', 'AI_EMPTY_OUTPUT']
    ]
    for (const [message, expected] of cases) {
      expect(classifyTaskError(new Error(message)), message).toBe(expected)
    }
  })

  it('步骤参数里指定的自定义错误码也要透出（白名单法在这里必然失效）', () => {
    // requireQuota / requireTextAbsent 的 code 由用户在编排里指定，
    // 源码里根本没有这个字面量，只靠白名单永远认不出来。
    const custom = 'TASK_MY_PRODUCT_MISSING'
    const quota = new Error(`${custom}: 数值不足——页面显示「已选商品 0」（需要 ≥ 1）`)
    expect(classifyTaskError(quota)).toBe(custom)

    const absent = new Error('MY_ABSENT_CODE: 页面上出现了「部分邀约发送失败」')
    expect(classifyTaskError(absent)).toBe('MY_ABSENT_CODE')
  })

  it('loop 包装错误必须透出内层真实码（否则 stopOn / onCode 永远匹配不上）', () => {
    // 内层是已知码
    expect(classifyTaskError(new Error(
      'LOOP_ROUND_FAILED: 第 6/40 轮（子步骤 1/9 requireQuota）失败：TASK_QUOTA_EXCEEDED: 数值不足'
    ))).toBe('TASK_QUOTA_EXCEEDED')
    // 内层是自定义码
    expect(classifyTaskError(new Error(
      'LOOP_ROUND_FAILED: 第 2/5 轮（子步骤 3/8 clickAll）失败：TASK_SELECTION_SHORTFALL: 只勾中 3 位'
    ))).toBe('TASK_SELECTION_SHORTFALL')
    // 包装码本身不该被当成结果
    expect(classifyTaskError(new Error('LOOP_ROUND_FAILED: 第 1/1 轮失败：未知问题'))).toBe('INTERNAL_ERROR')
  })

  it('认不出来时退回 INTERNAL_ERROR（不伪造具体原因）', () => {
    expect(classifyTaskError(new Error('socket hang up'))).toBe('INTERNAL_ERROR')
    expect(classifyTaskError(new Error('https://a.com/x 加载失败'))).toBe('INTERNAL_ERROR')
    expect(classifyTaskError('完全无法识别的字符串')).toBe('INTERNAL_ERROR')
    expect(classifyTaskError(undefined)).toBe('INTERNAL_ERROR')
  })

  it('消息正文里引用的错误码不算数（只认开头/冒号后那个）', () => {
    // 兜底不能太宽：loop 的 stopOn 把命中的码当成"按预期收工"，
    // 误命中就是"明明没发出去却记成功"。正文引用的情况必须仍走外层真实码。
    expect(classifyTaskError(new Error(
      'TASK_SELECTOR_CHANGED: 页面显示「MY_PAGE_LABEL 已失效」，未找到元素'
    ))).toBe('TASK_SELECTOR_CHANGED')
    // URL 里带下划线的大写片段同样不算
    expect(classifyTaskError(new Error('https://example.com/A_B/path 加载失败'))).toBe('INTERNAL_ERROR')
  })

  it('重复调用结果稳定（不因正则 lastIndex 之类产生抖动）', () => {
    const msg = new Error('TASK_CUSTOM_THING: 说明')
    expect(classifyTaskError(msg)).toBe('TASK_CUSTOM_THING')
    expect(classifyTaskError(msg)).toBe('TASK_CUSTOM_THING')
  })

  it('task-runner 里每个抛出的错误码都不会落成 INTERNAL_ERROR', () => {
    // 只认 `new Error('CODE: …')` 这种"消息以码开头"的写法，
    // 避免把对象键名（TRANSITIONS:）之类的噪音算进来。
    const codes = new Set<string>()
    for (const m of RUNNER_SRC.matchAll(/new Error\(\s*['"`]([A-Z][A-Z0-9_]{5,}):/g)) codes.add(m[1])
    expect(codes.size, '没扫到错误码说明正则失配了').toBeGreaterThan(8)

    const swallowed = [...codes]
      .filter(code => code !== 'LOOP_ROUND_FAILED') // 包装码，取内层
      .filter(code => classifyTaskError(new Error(`${code}: 说明`)) === 'INTERNAL_ERROR')
    expect(
      swallowed,
      `这些错误码会被吞成 INTERNAL_ERROR（界面显示"内部错误"）：${swallowed.join(', ')}`
    ).toEqual([])
  })
})
