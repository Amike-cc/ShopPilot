import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { classifyTaskError, KNOWN_ERROR_CODES } from '../../apps/desktop/src/main/tasks/error-classifier'

/**
 * 「静默假成功」边界的回归测试（2026-09-28 审查确认的 P0）。
 *
 * 背景：`TASK_QUOTA_EXCEEDED` 同时承担了三种含义——
 *   ① 页面明示额度不足；② 额度文案**读不到数字**；③ 「确认发送」按钮**因任何原因**禁用。
 * 而它是邀约 loop 的 `stopOn` 之一，命中即"按预期成功收尾"。于是②③会变成
 * **任务报成功、一位邀约都没发出去**，用户毫不知情。
 *
 * 修法：②③改用独立码（`TASK_QUOTA_UNREADABLE` / `TASK_TARGET_DISABLED_UNCERTAIN`），
 * 并且这两个码**绝不能**进任何 stopOn——否则等于没改。本文件把这条边界焊死。
 */

const NEW_CODES_NOT_IN_STOP_ON = ['TASK_QUOTA_UNREADABLE', 'TASK_TARGET_DISABLED_UNCERTAIN']

describe('额度/禁用语义边界', () => {
  it('两个新码必须被错误分类器认识（否则 run 的 error_code 会退化成 INTERNAL_ERROR）', () => {
    for (const code of NEW_CODES_NOT_IN_STOP_ON) {
      expect(KNOWN_ERROR_CODES).toContain(code)
      expect(classifyTaskError(new Error(`${code}: 说明`))).toBe(code)
    }
  })

  it('两个新码不得出现在任何步骤档案的 stopOn 里（进了就等于静默假成功）', () => {
    const dir = resolve('packages/shared/src')
    const files = readdirSync(dir).filter(f => f.endsWith('.ts'))
    const stopOnLines: string[] = []
    for (const f of files) {
      const src = readFileSync(resolve(dir, f), 'utf8')
      for (const line of src.split(/\r?\n/)) {
        if (/stopOn\s*:/.test(line)) stopOnLines.push(`${f}: ${line.trim()}`)
      }
    }
    // 至少要扫到已知的两处（防止"文件改名/结构变了导致这条测试空转"）
    expect(stopOnLines.length).toBeGreaterThan(0)
    for (const line of stopOnLines) {
      for (const code of NEW_CODES_NOT_IN_STOP_ON) {
        expect(line, `stopOn 里出现了「读失败/归因不明」类错误码 → 会静默报成功：${line}`).not.toContain(code)
      }
    }
  })

  it('requireEnabled 的额度文案是**显式登记**的（默认不再把禁用一律当额度用尽）', () => {
    const schema = readFileSync(resolve('apps/desktop/src/main/tasks/task-step-schemas.ts'), 'utf8')
    expect(schema).toContain('quotaDisabledIncludes')
    const runner = readFileSync(resolve('apps/desktop/src/main/tasks/task-runner.ts'), 'utf8')
    // 禁用分支必须同时存在"匹配登记文案 → QUOTA_EXCEEDED"与"否则 UNCERTAIN"两条路
    expect(runner).toContain('TASK_TARGET_DISABLED_UNCERTAIN')
    expect(runner).toMatch(/quotaDisabledIncludes/)
  })

  it('requireEnabled 的额度判定必须由**档案显式声明**，且抖店确有声明（否则日常额度用尽会报失败）', async () => {
    const { inviteProfileFor } = await import('@shared/constants/invite')
    const douyin = inviteProfileFor('抖店')!
    // 抖店实测：额度用尽 = 「确认发送」禁用且读不到浮层说明 → 只能靠档案级声明
    expect(douyin.quotaDisabledMeansExhausted).toBe(true)
    // 快手走 requireQuota（页面明示数字），不该也不需要这条声明
    const kuaishou = inviteProfileFor('快手小店')!
    expect(kuaishou.quotaDisabledMeansExhausted).toBeUndefined()

    // 构建出的步骤要把声明透传给引擎（否则档案声明了、引擎还是按"不确定"失败）
    const { buildInviteTaskPayload, normalizeInviteTaskConfig } = await import('@shared/invite-task')
    const config = normalizeInviteTaskConfig('batch-list', {
      category: '美妆', levels: ['LV0'], count: 2, script: '你好', scriptMode: 'manual',
      batchContact: '张三', batchPhone: '13800138000', batchWechat: 'wx'
    })
    const payload = buildInviteTaskPayload({ profile: douyin, storeId: 'store_a', squareUrl: douyin.pageUrl, config })
    expect(payload).not.toBeNull()
    const requireEnabled = JSON.stringify(payload!.steps).includes('"disabledMeansQuota":true')
    expect(requireEnabled, '抖店邀约步骤缺少 disabledMeansQuota 透传').toBe(true)
  })

  it('"额度读不到"与"额度不足"是两个不同的码（前者不在 stopOn 语义内）', () => {
    const runner = readFileSync(resolve('apps/desktop/src/main/tasks/task-runner.ts'), 'utf8')
    // ① 读不到数字的两处必须用 UNREADABLE
    const unreadable = runner.match(/TASK_QUOTA_UNREADABLE/g) || []
    expect(unreadable.length).toBeGreaterThanOrEqual(2)
    // ② "数字 < min" 那处仍用 QUOTA_EXCEEDED（确定性业务判据，按预期收尾是对的）
    expect(runner).toContain('数值不足——页面显示')
  })
})

describe('下载文件名净化（平台的 Content-Disposition 不可信）', () => {
  vi.mock('electron', async () => {
    const os = await import('node:os')
    return {
      app: { getPath: () => os.tmpdir() },
      session: { fromPartition: () => ({}) },
      Session: class {}
    }
  })
  const load = async () => (await import('../../apps/desktop/src/main/browser/session-manager')).safeDownloadName

  it('剥掉目录穿越片段，只留文件名', async () => {
    const safe = await load()
    expect(safe('..\\..\\Windows\\System32\\evil.exe')).toBe('evil.exe')
    expect(safe('../../etc/passwd')).toBe('passwd')
    expect(safe('a/b/c.pdf')).toBe('c.pdf')
  })

  it('挡 Windows 保留设备名与尾随点/空格', async () => {
    const safe = await load()
    expect(safe('CON')).toBe('_CON')
    expect(safe('nul.txt')).toBe('_nul.txt')
    expect(safe('报告. ')).toBe('报告')
    expect(safe('   ')).toBe('download')
  })

  it('清掉非法字符与控制字符，保留中文与扩展名', async () => {
    const safe = await load()
    expect(safe('订单<明细>:"|?*.xlsx')).toBe('订单明细.xlsx')
    expect(safe('a\u0000b\u001fc.txt')).toBe('abc.txt')
  })
})
