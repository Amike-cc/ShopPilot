import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  STEP_IDEMPOTENT_TYPES,
  canRetryStepInPlace,
  isIdempotentStepType
} from '@shared/agent-step-effects'
import { STEP_CATALOG } from '@shared/custom-task'
import { TASK_STEP_TYPES } from '@shared/schemas/task'
import { normalizeStepRetryLimit } from '../../apps/desktop/src/main/tasks/task-step-schemas'

/**
 * "非幂等步骤不许重试"这条红线的回归测试（2026-09-28 审查）。
 *
 * 背景：这条规则此前只装在**编辑器侧**（`custom-task.STEP_CATALOG.idempotent` →
 * 校验报错），而主进程 `validateStepInput` 完全没拦，引擎的 run 内重试路径
 * （`task-runner` 的 `attempt < step.retryLimit`）也不查副作用集合——只有"跨 run 恢复"
 * 那条路查了。于是直落 `task:create`/`task:update` 的通道（粘贴 JSON、导入、将来的
 * 第三方调用方）可以给 `clickByText` 设 `retryLimit: 5`，一次超时就是**重复提交/重复邀约**。
 *
 * 现在两处取值都走 `isIdempotentStepType`，并且 `waitUrl` 的重发点击默认关掉
 * （要重发必须由档案显式声明 attempts，如微信「邀请带货」的 attempts:4）。
 */

/** 允许原地重试 = 可覆盖写入 + 只读/等待/导航类；其余（点击/循环/门禁/切标签）必须为 0 */
const RETRY_ALLOWED = [
  'navigate', 'waitForPage', 'waitForSelector', 'waitForText', 'waitMs', 'waitForGone',
  'readText', 'readLabelValue', 'readTable', 'screenshot', 'hover', 'pressKey',
  'mirrorTabUrl', 'requireQuota', 'requireEnabled', 'requireTextAbsent',
  'setInput', 'typeText', 'fillDraft', 'ensureRows', 'ensureRowsById', 'aiGenerate'
]
const RETRY_FORBIDDEN = ['click', 'clickByText', 'clickAll', 'clickIfPresent', 'loop', 'waitForUserConfirmation', 'useTab']

describe('步骤重试闸（单一事实来源）', () => {
  it('幂等集合与引擎步骤类型是一一对应：22 允许 + 7 禁止 = 全部 29 种', () => {
    expect([...STEP_IDEMPOTENT_TYPES].sort()).toEqual([...RETRY_ALLOWED].sort())
    expect(RETRY_ALLOWED.length + RETRY_FORBIDDEN.length).toBe(TASK_STEP_TYPES.length)
    // 每个引擎步骤类型都被明确分类，没有"漏登记"的类型（漏登记=只能靠 fail-closed 兜）
    for (const type of TASK_STEP_TYPES) {
      const expected = RETRY_ALLOWED.includes(type)
      expect(isIdempotentStepType(type), `${type} 的幂等判定与预期不符`).toBe(expected)
    }
  })

  it('与编辑器侧的 STEP_CATALOG.idempotent 完全一致（同一规则不许有两份口径）', () => {
    for (const entry of STEP_CATALOG) {
      expect(isIdempotentStepType(entry.type), `catalog「${entry.label}」(${entry.type}) 与 shared 判定不一致`)
        .toBe(entry.idempotent)
    }
  })

  it('未知类型 fail-closed：当作不可重试', () => {
    expect(isIdempotentStepType('brandNewStepFromTheFuture')).toBe(false)
    expect(isIdempotentStepType(undefined)).toBe(false)
    expect(canRetryStepInPlace('brandNewStepFromTheFuture', 3)).toBe(false)
  })

  it('normalizeStepRetryLimit：非幂等一律归零，幂等保留并夹到 0~5', () => {
    // 会提交的动作：归零（这就是本次修复的核心）
    for (const type of RETRY_FORBIDDEN) {
      expect(normalizeStepRetryLimit(type, 5), `${type} 必须被归零`).toBe(0)
      expect(normalizeStepRetryLimit(type, 1), `${type} 必须被归零`).toBe(0)
    }
    // 可覆盖写入/只读：保留
    expect(normalizeStepRetryLimit('setInput', 2)).toBe(2)
    expect(normalizeStepRetryLimit('typeText', 1)).toBe(1)
    expect(normalizeStepRetryLimit('navigate', 3)).toBe(3)
    // 边界：未声明 / 0 / 负数 / 非数字 → 0；超上限 → 5
    expect(normalizeStepRetryLimit('setInput', undefined)).toBe(0)
    expect(normalizeStepRetryLimit('setInput', 0)).toBe(0)
    expect(normalizeStepRetryLimit('setInput', -1)).toBe(0)
    expect(normalizeStepRetryLimit('setInput', Number.NaN)).toBe(0)
    expect(normalizeStepRetryLimit('setInput', 99)).toBe(5)
    expect(normalizeStepRetryLimit('typeText', 2.7)).toBe(2)
  })

  it('canRetryStepInPlace：旧数据里的 retryLimit 也不能让非幂等步骤重试', () => {
    // 修复前落库的历史行：clickByText + retryLimit 3 → 运行时仍必须拒绝
    expect(canRetryStepInPlace('clickByText', 3)).toBe(false)
    expect(canRetryStepInPlace('loop', 2)).toBe(false)
    // 幂等步骤照常
    expect(canRetryStepInPlace('aiGenerate', 2)).toBe(true)
    expect(canRetryStepInPlace('setInput', 1)).toBe(true)
    expect(canRetryStepInPlace('setInput', 0)).toBe(false)
  })
})

describe('邀约档案的重试声明（真机动机不能被我改坏）', () => {
  const source = readFileSync(resolve('packages/shared/src/invite-steps.ts'), 'utf8')

  it('档案里每个 retryLimit 都只出现在幂等步骤上', () => {
    // 按 push 的对象块切分，逐块取第一个 type
    const chunks = source.split(/round\.push\(\{/).slice(1)
    const declared: Array<{ type: string; limit: number }> = []
    for (const chunk of chunks) {
      const m = /type:\s*'([a-zA-Z0-9]+)'/.exec(chunk)
      const r = /retryLimit:\s*(\d+)/.exec(chunk)
      if (!m || !r) continue
      declared.push({ type: m[1], limit: Number(r[1]) })
    }
    expect(declared.length, '档案里应当至少有一条显式重试声明（aiGenerate）').toBeGreaterThan(0)
    for (const d of declared) {
      expect(isIdempotentStepType(d.type), `档案给非幂等步骤「${d.type}」设了 retryLimit:${d.limit}`).toBe(true)
      // 而且要能通过主进程归一化（不被归零）——这条就是"第 25 轮模型超时不该打掉整单"的保障
      expect(normalizeStepRetryLimit(d.type, d.limit)).toBe(d.limit)
    }
  })

  it('微信「邀请带货」的 waitUrl.attempts 是显式声明的（默认已改为不重发点击）', () => {
    expect(source).toMatch(/waitUrl:\s*\{\s*includes:[^}]*attempts:\s*4/)
  })
})
