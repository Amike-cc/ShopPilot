/**
 * 步骤副作用边界 —— **单一事实来源**。
 *
 * 为什么单独一份：这条边界原先在三个地方各写了一遍，而且三份内容不一致：
 *   · `agent-domain-rules.deriveJobRisk` 只按**文案正则**判风险（`\b(click|write|fill|select|invite|update|create)\b`）；
 *   · `tasks/task-step-schemas.NON_RESUMABLE_TYPES` 列了 13 个步骤类型；
 *   · `services/agent-planner.SIDE_EFFECT_TYPES` 只有 2 个（click/clickByText）。
 *
 * 后果（2026-09-26 审计确认）：`"type":"clickByText"`、`setInput`、`typeText`、`aiGenerate`、
 * `ensureRows*`、`useTab`、`loop`、`clickAll`、`clickIfPresent` 都不匹配那条正则
 * （`\bclick\b` 要求 click 后面是词边界），于是这类浏览器 Job 被判成 `read`：
 *   1) 可以派给 `storeScope.readOnly` 的执行者（越权）；
 *   2) 不置 `side_effect_started` → `resumeAgentJob` 放行"安全恢复"，而恢复是新 run 从第 0 步重放
 *      → 重复点击/重复写入。
 *
 * 现在三处都从这里取值，禁止再各写一份（`tests/unit/agent-step-effects.test.ts` 用集合同一性锁死）。
 */

/** 会对页面产生副作用的步骤类型（点了/写了就是真发出去了）。 */
export const AGENT_SIDE_EFFECT_STEP_TYPES: ReadonlySet<string> = new Set<string>([
  // 点击类
  'click', 'clickByText', 'clickAll', 'clickIfPresent',
  // 写入类
  'setInput', 'typeText', 'ensureRows', 'ensureRowsById', 'fillDraft',
  // 由模型生成内容并写入（邀约话术）
  'aiGenerate',
  // 循环体里通常含点击/写入（一循环就是一轮真实发送）
  'loop'
])

/**
 * 不可从失败恢复重放的步骤类型：
 * 副作用步骤（重放 = 重复副作用）∪ 运行态/等待类（重放没有意义）。
 *
 * 注意 `hover` / `pressKey(Escape)` / `screenshot` / `readText` 等**故意不在**这里：
 * 它们不改页面状态，重放安全。
 */
export const AGENT_NON_RESUMABLE_STEP_TYPES: ReadonlySet<string> = new Set<string>([
  ...AGENT_SIDE_EFFECT_STEP_TYPES,
  'waitForUserConfirmation',
  // 切标签页会改写运行态（tabId），重放没有意义
  'useTab'
])

/**
 * 可安全**原地重试**的步骤类型（重跑一次不会多产生一次副作用）——只有这类才允许设 `retryLimit`。
 *
 * 与"有没有副作用"不是一回事，别混用：
 *   · `setInput` / `typeText` / `fillDraft` 改页面状态，但重跑只是把**同一个值再写一遍**（覆盖）；
 *   · `ensureRows*` 是"确保选中"，重跑收敛到同一状态；
 *   · `aiGenerate` 重跑=重新生成并覆盖同一个输入框（`invite-steps` 给的 `retryLimit: 2` 依赖这条，
 *     真机动机见那里的注释：第 25 轮模型超时不该把已真实发出的 24 位一起打掉）；
 *   · 而 `click*` 再点一次就是**真的多发一次**（重复提交/重复邀约），`loop` 重跑=整整多跑一轮。
 *
 * 与 [[AGENT_NON_RESUMABLE_STEP_TYPES]] 的区别（2026-09-28 审查确认，这是两件事）：
 *   · NON_RESUMABLE 管"能不能**从失败恢复重放**"——恢复是新 run 从第 0 步重放，连同前面的点击
 *     一起重做，所以它保守到把幂等写入也排除；
 *   · 本集合只管"**单步**能不能原地重试"——只有非幂等动作必须为 0。
 * 关系：NON_RESUMABLE = (全部类型 - 本集合) ∪ {运行态/门禁类}。
 *
 * 未知类型一律**非幂等**（fail-closed）：将来新增步骤类型若忘了登记，只是丢掉重试这一便利，
 * 不会变成"新类型可以重复点击"。
 */
export const STEP_IDEMPOTENT_TYPES: ReadonlySet<string> = new Set<string>([
  // 导航/等待/只读类：重跑无副作用
  'navigate', 'waitForPage', 'waitForSelector', 'waitForText', 'waitMs', 'waitForGone',
  'readText', 'readLabelValue', 'readTable', 'screenshot', 'hover', 'pressKey',
  'mirrorTabUrl', 'requireQuota', 'requireEnabled', 'requireTextAbsent',
  // 覆盖式写入：重跑只是把同一个值再写一遍
  'setInput', 'typeText', 'fillDraft', 'ensureRows', 'ensureRowsById',
  // 生成并覆盖同一输入框
  'aiGenerate'
])

export function isIdempotentStepType(type: unknown): boolean {
  return typeof type === 'string' && STEP_IDEMPOTENT_TYPES.has(type)
}

/**
 * 允许原地重试的判定（`retryLimit > 0` 且该步骤**构造上幂等**）。
 * 主进程落库侧与引擎运行侧**必须都走这一个函数**：
 * 前者挡新数据，后者挡"修复前已落库的旧任务"（那些行里可能已经存着非幂等步骤的 retryLimit）。
 *
 * 除了幂等类型，还放行一类**构造上幂等的点击**：带 `skipIfChecked + verifyChecked` 的复选框筛选
 * （2026-10-04 真机：用户连发时第 1 轮就死在 `TASK_FILTER_NOT_APPLIED: 「母婴」点了但没有生效`）。
 * 它重跑是安全的——已勾选则 skipIfChecked 命中不点、未勾选则重新定位再点；
 * 勾选态本身就是它的幂等判据，没有任何不可逆副作用。判据放在 `isIdempotentCheckboxFilterStep`，
 * 与落库侧的 `normalizeStepRetryLimit` 共用，避免两处漂移。
 */
export function canRetryStepInPlace(type: unknown, retryLimit: unknown, input?: unknown): boolean {
  const limit = Number(retryLimit)
  if (!Number.isFinite(limit) || limit <= 0) return false
  return isIdempotentStepType(type) || isIdempotentCheckboxFilterStep(type, input)
}

/** 带 skipIfChecked + verifyChecked 的复选框筛选点击：构造上幂等（见 canRetryStepInPlace） */
export function isIdempotentCheckboxFilterStep(type: unknown, input?: unknown): boolean {
  if (type !== 'clickByText' || !input || typeof input !== 'object') return false
  const record = input as Record<string, unknown>
  return record.skipIfChecked === true && record.verifyChecked === true
}

export function isSideEffectStepType(type: unknown): boolean {
  return typeof type === 'string' && AGENT_SIDE_EFFECT_STEP_TYPES.has(type)
}

export function isNonResumableStepType(type: unknown): boolean {
  return typeof type === 'string' && AGENT_NON_RESUMABLE_STEP_TYPES.has(type)
}

/**
 * 收集一段结构里出现的所有步骤类型（递归进 loop 的 body/steps）。
 *
 * 口径：只要是对象上值为字符串的 `type` 字段就算（有深度与数量上限，避免超深载荷拖慢判定）。
 * 只用来做"里面有没有副作用步骤"的判断，不做校验——校验由各步骤自己的 Zod schema 负责。
 */
export function collectStepTypes(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || out.length > 400 || value == null) return out
  if (Array.isArray(value)) {
    for (const item of value) collectStepTypes(item, depth + 1, out)
    return out
  }
  if (typeof value !== 'object') return out
  const record = value as Record<string, unknown>
  if (typeof record.type === 'string') out.push(record.type)
  for (const key of ['steps', 'body', 'input', 'browserTask']) {
    if (record[key] !== undefined) collectStepTypes(record[key], depth + 1, out)
  }
  return out
}

/** 这段结构里是否有副作用步骤（或直接给了一个副作用步骤类型字符串）。 */
export function hasSideEffectSteps(value: unknown): boolean {
  if (isSideEffectStepType(value)) return true
  return collectStepTypes(value).some(isSideEffectStepType)
}

/** 这段结构里是否有"不可重放"的步骤（恢复门禁/重试上限用它，而不是各自判断）。 */
export function hasNonResumableSteps(value: unknown): boolean {
  if (isNonResumableStepType(value)) return true
  return collectStepTypes(value).some(isNonResumableStepType)
}
