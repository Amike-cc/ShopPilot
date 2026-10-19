/**
 * 单次 run 的执行循环：标签页准备、逐步执行与重试闸、终态收尾。
 * 2026-10-19 P1 重构：由 task-runner.ts 等价搬迁（实现与注释逐字保留）。
 */

import { canRetryStepInPlace, shouldUseInternalRunTab } from '@shared/agent-step-effects'
import { logMain } from '../services/logger'
import { inviteStopReasonLabel } from '@shared/invite-notices'
import { createTab, getTabWebContents, getStoreTabs, activateTab, getActiveTabId, waitForTabWebContents, setStoreTaskActivity, acquireCollectionTab } from '../browser/window-manager'
import { waitForStoreSessionReady } from '../browser/session-manager'
import * as TaskStore from './task-store'
import { isInternalRunTab } from './task-step-dom'
import { execStep } from './task-step-executor'
import { classifyError, emitProgress, transition } from './task-runner-lifecycle'
import { runTabByStore } from './task-runner-registry'
import type { RunHandle } from './task-runner-registry'

// ---------- 执行循环 ----------

/**
 * 把运行标签页**切到前台并等它的 guest 挂上**，切不回来就明确失败。
 *
 * 为什么每一步都要确认（2026-10-03 真机定位到的根因，值得写清楚）：
 * 迁移到 DOM `<webview>` 后，**只有活动标签页的 webview 挂在文档上**；后台标签页的 guest 会被卸载。
 * 于是运行标签页一旦被切走，页面即使 JS 还能跑，`getBoundingClientRect()` 也是 0 ——
 * 所有**可见性判据**（waitForText / clickByText 都要求 rect>0）必然失败，而 URL 类判据照常通过。
 * 现场表现极具迷惑性：任务自报"导航成功"，采样却看到页面从头到尾停在旧地址，
 * 第 3 步等「带货类目」硬等 40s 超时（真机连发反复踩到三次）。
 *
 * 谁会切走它：用户手动点别的标签页、面板「打开达人广场」、脚本开「我的达人」页等——
 * 都可能发生在任务运行中间。所以这里**每步开头都重新确认一次**，被切走就切回来。
 */
async function ensureRunTabForeground(run: RunHandle, why: string): Promise<void> {
  if (!run.tabId) return
  /**
   * **采集专用页（internal）不切前台**（2026-10-15 用户要求「采集数据的时候不要影响浏览器使用」）。
   *
   * 渲染层对 internal 标签页是**隐藏挂载**（`opacity:0` 但保留布局盒），所以 guest 照样注册、
   * `getBoundingClientRect()` 照样有真实尺寸——页面内所有可见性判据都成立，而用户的当前页
   * 一点不动。产品同步、经营数据采集从 2026-10-02 起就是这么跑的（见
   * window-manager.createTab 的 opts.internal 与 DashboardBrowserSurface 的隐藏挂载）。
   *
   * 为什么要专门挡一下：任务式采集（发票 / 涉税 / 主体）以前建的是**普通标签页**，
   * 于是每步开头这一步都会把用户正在看的页面切走——用户看到的现象就是"一采集，视图自己跳"。
   */
  if (isInternalRunTab(run)) return
  const active = getActiveTabId(run.storeId)
  if (active === run.tabId && getTabWebContents(run.storeId, run.tabId)) return
  try { activateTab(run.storeId, run.tabId) } catch { /* 标签页已消失：下面的等待会如实报错 */ }
  try {
    await waitForTabWebContents(run.storeId, run.tabId, 20_000)
  } catch (e: any) {
    const message = String(e?.message || e).replace(/^BROWSER_NOT_READY:\s*/, '')
    throw new Error(`TASK_TAB_NOT_FOREGROUND: 运行标签页未能切到前台（${why}）——${message}`)
  }
  const now = getActiveTabId(run.storeId)
  if (now !== run.tabId) {
    throw new Error(`TASK_TAB_NOT_FOREGROUND: 运行标签页未能切到前台（${why}）——当前前台是 ${now || '无'}；页面不可见时所有"可见性"判据都会失败，继续跑只会白等超时`)
  }
  logMain('info', `[task] 运行标签页已切回前台 run=${run.runId} tab=${run.tabId}（${why}）`)
}

export async function execute(run: RunHandle): Promise<void> {
  setStoreTaskActivity(run.storeId, true)
  try {
    if (run.resumeKind === 'new') transition(run, 'running', run.reason)
    else if (run.resumeKind === 'continue') transition(run, 'running', '用户恢复执行')
    else transition(run, 'running', '从失败步骤恢复，跳过已完成步骤')

    // 任务运行标签页：**按店铺复用**（此前每个 run 新建一个、从不回收——实测一天下来
    // 堆了 10 个渲染进程、约 1.5GB 内存）。复用不影响步骤正确性：抖店流程第 1 步就是
    // navigate、微信流程第 1 步是 mirrorTabUrl，都会把页面重新加载到目标地址。
    const firstStep = run.steps[run.startFrom]
    const requestedTabId = firstStep?.type === 'useTab' && typeof firstStep.input?.tabId === 'string'
      ? String(firstStep.input.tabId)
      : null
    // 标签页"还在不在"用主进程的标签表判断，不能用 getTabWebContents：
    // 页面句柄要等 Renderer 的 <webview> 注册才有，拿它判存活会把"刚重载、还在注册路上"
    // 误报成"标签页已关闭"（2026-09-28 迁移 DOM webview 时确认的差异）。
    const tabExists = (tabId: string | null | undefined): boolean =>
      !!tabId && getStoreTabs(run.storeId).some(t => t.id === tabId)
    if (requestedTabId && !tabExists(requestedTabId)) {
      const message = '计划绑定的标签页已关闭，请重新观察页面并创建任务'
      TaskStore.updateRun(run.runId, { errorCode: 'TASK_TAB_NOT_FOUND', errorMessage: message })
      transition(run, 'failed', message)
      return
    }
    // 这次的运行标签页形态：纯采集走**采集专用页**（隐藏、不抢活动位、用户完全无感）；
    // 含"用户要看着页面"的步骤（确认/镜像核对）则用普通页并切前台。
    const internalRun = shouldUseInternalRunTab(run.steps)
    if (requestedTabId) {
      // Agent 计划显式绑定生成计划时的标签页；不新建 about:blank 再切换，避免误读其他页面。
      run.tabId = requestedTabId
    } else if (internalRun) {
      /**
       * **采集专用页**（2026-10-15 用户要求「采集数据的时候不要影响浏览器使用」）。
       *
       * 用 window-manager 的 `acquireCollectionTab`——这条 API 从 2026-10-02 起就存在
       * （经营数据每 10 分钟一轮用的就是它），只是**任务式采集一直没迁移过来**：
       * 以前这里建的是普通标签页，于是采集一开始就把用户正在看的页面切走、标签栏还多一个页。
       * 它按店铺缓存、只建一个、不激活、不落库、不进标签栏；渲染层挂隐藏 webview 给它。
       *
       * **刻意不走 `runTabByStore`**：那张表可能存着旧版本建的普通页，复用它等于把抢视图的行为带回来。
       */
      run.tabId = acquireCollectionTab(run.storeId)
    } else if (!tabExists(run.tabId)) {
      const reusedId = runTabByStore.get(run.storeId)
      if (reusedId && tabExists(reusedId)) {
        run.tabId = reusedId
      } else {
        const firstNavigate = run.steps.find(s => s.type === 'navigate')
        // 含"用户要看着页面"的步骤（确认 / 镜像核对）→ 必须可见、必须切前台
        run.tabId = createTab(run.storeId, (firstNavigate?.input as any)?.url || 'about:blank')
        runTabByStore.set(run.storeId, run.tabId)
      }
    }
    // 新建标签的首个导航在 createTab 内等待代理配置；TaskRunner 也要先等同一门禁，
    // 避免第一步脚本在 session 尚未完成配置时读写页面。
    await waitForStoreSessionReady(run.storeId)
    /**
     * 顺序很关键：**先把运行标签页带到前台，再等 guest 注册**。
     *
     * 迁移到 DOM `<webview>` 之后只有**活动标签页**的 webview 挂在文档上，后台标签页的 guest
     * 不会被挂载；而这里复用的是 `runTabByStore` 里上一轮用过的标签页——它很可能停在后台。
     * 旧顺序（先等 45s 再 activateTab）在那种情况下必然等到超时，报
     * `BROWSER_NOT_READY: 店铺标签页 guest 在 45000ms 内未注册`（2026-10-03 真机实测：上一轮
     * 因为 AI 报错中断、遗留的运行标签页不在前台，紧接着的复跑就撞上这一条）。
     * 新建标签页那条路径本来就由 createTab 激活，所以此前没暴露。
     *
     * 2026-10-15 补充：**采集专用页（internal）不需要也不该切前台**——渲染层对它是隐藏挂载
     * （opacity:0 + 保留布局盒），guest 照常注册，页面内判据照常成立。硬切会把用户正在看的
     * 页面顶掉（「采集数据的时候不要影响浏览器使用」）。产品同步/经营采集走的就是这条路。
     */
    try { if (!isInternalRunTab(run)) activateTab(run.storeId, run.tabId!) } catch { /* 标签页已消失等情况不阻塞流程 */ }
    try {
      await waitForTabWebContents(run.storeId, run.tabId!, 45_000)
    } catch (e: any) {
      const message = String(e?.message || e).replace(/^BROWSER_NOT_READY:\s*/, '')
      TaskStore.updateRun(run.runId, { errorCode: 'BROWSER_NOT_READY', errorMessage: message })
      transition(run, 'failed', `页面未就绪：${message}`)
      return
    }
    // 起跑时再确认一次"真的在前台"（activateTab 之后仍可能被渲染层/其它动作切走）
    await ensureRunTabForeground(run, '起跑')

    const doneSet = run.skipDone ? TaskStore.succeededStepIndexes(run.runId) : new Set<number>()

    for (let i = run.startFrom; i < run.steps.length; i++) {
      if (run.cancelRequested) { transition(run, 'cancelled', '用户取消'); return }
      if (run.pauseRequested) {
        run.pauseRequested = false
        run.startFrom = i; run.resumeKind = 'continue'
        transition(run, 'paused', '用户暂停（将从该步骤继续）')
        return
      }
      if (doneSet.has(i)) {
        emitProgress(run, { phase: 'succeeded', stepIndex: i, stepType: run.steps[i].type, message: '跳过已完成步骤（恢复模式）' })
        continue
      }

      const step = run.steps[i]
      TaskStore.updateRun(run.runId, { currentStep: i })
      emitProgress(run, { phase: 'started', stepIndex: i, stepType: step.type })

      // 运行标签页必须**真的在前台**：见 ensureRunTabForeground 的说明
      await ensureRunTabForeground(run, `步骤 ${i + 1}/${run.steps.length} ${step.type}`)

      let attempt = 0
      for (;;) {
        try {
          const out = await execStep(run, step)
          // 每步成功都有落库凭据：产物步骤写内容结果，等待/导航类写 executed 行
          // （succeededStepIndexes 据此实现"恢复不重复执行已成功步骤" - §9.2）
          if (out) TaskStore.insertStepResult(run.runId, i, out.kind, out.payload, out.artifact)
          else if (!run.deniedByConfirm) TaskStore.insertStepResult(run.runId, i, 'executed', { done: true, stepType: step.type })
          if (run.deniedByConfirm) {
            transition(run, 'cancelled', '用户拒绝确认，门禁拦截')
            return
          }
          emitProgress(run, { phase: 'succeeded', stepIndex: i, stepType: step.type })
          break
        } catch (e: any) {
          if (e?.name === 'CancelSignal') {
            if (run.status === 'running' || run.status === 'waiting_confirmation') transition(run, 'cancelled', '用户取消')
            return
          }
          if (e?.name === 'PauseSignal') {
            if (run.status === 'running') {
              run.pauseRequested = false
              run.startFrom = i; run.resumeKind = 'continue'
              transition(run, 'paused', '用户暂停')
            }
            return
          }
          // 重试闸（与落库侧 `normalizeStepRetryLimit` 同源判定，走 `@shared/agent-step-effects`）：
          // 非幂等步骤（click*/loop/门禁/切标签）即使旧数据行里存着 retryLimit 也不许重试——
          // 一次超时重试就会把"确认发送 / 批量邀约"真的再发一遍，而且 `withTimeout` 超时后
          // 底层注入脚本仍在页面上跑，第二次点击会与第一次叠加。
          const retryBudget = canRetryStepInPlace(step.type, step.retryLimit, step.input) ? (step.retryLimit as number) : 0
          if (attempt < retryBudget && !run.cancelRequested && run.status === 'running') {
            attempt++
            try {
              logMain('warn', `[task] 步骤重试 run=${run.runId} step=${i + 1}/${run.steps.length} type=${step.type} 第${attempt}/${retryBudget}次：${String(e?.message).slice(0, 200)}`)
            } catch { /* 日志失败不影响重试 */ }
            emitProgress(run, { phase: 'retry', stepIndex: i, stepType: step.type, message: `第 ${attempt} 次重试：${String(e?.message).slice(0, 160)}` })
            continue
          }
          const code = classifyError(e)
          try {
            logMain('error', `[task] 步骤失败 run=${run.runId} task=${run.taskId} store=${run.storeId} step=${i + 1}/${run.steps.length} type=${step.type} code=${code}：${String(e?.message || e).slice(0, 300)}`)
          } catch { /* 日志失败不能影响失败落库 */ }
          TaskStore.updateRun(run.runId, { errorCode: code, errorMessage: String(e?.message || e).slice(0, 500) })
          run.startFrom = i
          transition(run, 'failed', `步骤 ${i + 1}/${run.steps.length}（${step.type}）失败`)
          return
        }
      }
    }

    /**
     * 运行终态文案：达人邀约把 loop 的停止码与完成轮数带进 statusReason，
     * 通知中心/批次页不用再翻 task_step_results 才能说清"为什么停"。
     */
    const inviteStop = run.taskKind === 'creator_invite'
      ? (inviteStopReasonLabel(run.lastStopReason) || '达到本次上限')
      : null
    const successReason = inviteStop
      ? `达人邀约结束：${inviteStop}，完成 ${run.lastCompletedRounds} 轮`
      : '全部步骤完成'
    transition(run, 'succeeded', successReason)
  } catch (e: any) {
    try {
      logMain('error', `[task] 引擎异常 run=${run.runId} task=${run.taskId} store=${run.storeId}：${String(e?.stack || e?.message || e).slice(0, 500)}`)
    } catch { /* 日志失败不能影响落库 */ }
    try { TaskStore.updateRun(run.runId, { errorCode: 'INTERNAL_ERROR', errorMessage: String(e?.message || e).slice(0, 500) }) } catch { /* ignore */ }
    try { transition(run, 'failed', '引擎异常') } catch { /* 状态机不允许则保留现场 */ }
  } finally {
    setStoreTaskActivity(run.storeId, false)
  }
}
