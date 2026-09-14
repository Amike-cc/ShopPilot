/**
 * 发票中心「抓取待开票信息」的步骤构造（**多开票方向**）。
 *
 * 一条采集任务覆盖该平台的所有方向。每个方向的步骤序列可能是：
 *   - 同页默认方向：readTable
 *   - 同页另一方向：clickByText(页签) → waitMs → readTable
 *   - 另一个页面上的方向：navigate(该方向地址) → waitMs → readTable 或 readLabelValue
 * 全部是读取型步骤、无副作用、可安全重试。
 *
 * 为什么用 readTable 而不是逐字段 readText：发票是"一行一张单"的表格，各平台列数不同
 * （拼多多 15 列、抖店 4 列），逐列读会写死大量锚点；整表读回后按表头文案映射，平台加列也不会崩。
 * 卡片式的方向（没有表格，只有"标签 + 值"）用 readLabelValue，一个标签一条快照。
 *
 * **为什么切方向用 mode:'real'**：实测微信发票页顶部有与页签**同名**的普通 DIV（y≈167，非页签），
 * 按文案点很容易命中它、方向根本没切——上一版"只抓到一个方向"就是这个原因。
 *
 * allowJsWhenDetached：采集是从**发票中心弹层里**发起的，而弹层一打开，店铺的原生视图
 * 就被摘除（window-manager 的 setBrowserViewsObscured），页面视口变成 0×0，受信任鼠标
 * 物理上到不了页面——实测每个方向切换都报 TASK_TARGET_COVERED/unknown。
 * 切页签是纯页内状态切换（点了之后页面自己重渲染），实测 JS 多级点击 3s 内就能把对方数据
 * 切出来（表头多出「处理状态/操作」、行数 5 → 2），所以这里显式允许降级。
 */

import type { InvoiceProfile, InvoiceSection } from './constants/invoice'

export interface InvoiceStepDraft {
  type: string
  input: Record<string, unknown>
  timeoutMs?: number
}

function tabClick(section: InvoiceSection, deep: boolean): InvoiceStepDraft {
  return {
    type: 'clickByText',
    input: {
      text: section.tabText,
      ...(deep ? { deep: true } : {}),
      mode: 'real',
      // 视图未挂载时降级为 JS 点击（见文件头说明）——切页签不依赖浏览器输入管线
      allowJsWhenDetached: true
    },
    timeoutMs: 25000
  }
}

export function buildInvoiceCollectSteps(p: InvoiceProfile): InvoiceStepDraft[] {
  const steps: InvoiceStepDraft[] = [
    { type: 'navigate', input: { url: p.pageUrl }, timeoutMs: 45000 },
    { type: 'waitForPage', input: { urlIncludes: p.urlMarker }, timeoutMs: 45000 }
  ]
  // 首次读表前的等待（页面异步取数）
  steps.push({ type: 'waitMs', input: { ms: p.settleMs || 6000 } })

  p.sections.forEach((sec, i) => {
    // 该方向在**另一个页面**（实测拼多多给平台开票在资金中心）→ 先导航过去
    if (sec.pageUrl) {
      steps.push({ type: 'navigate', input: { url: sec.pageUrl }, timeoutMs: 45000 })
      // 资金中心会再跳到 cashier 域名，urlMarker 取不到就别硬等，用固定等待
      steps.push({ type: 'waitMs', input: { ms: p.settleMs || 6000 } })
    }
    // 切方向：没写 tabText = 页面默认方向，不用点；其余方向点一次
    if (sec.tabText) {
      steps.push(tabClick(sec, !!p.deep))
      // 切完要等页内重渲染 + 重新取数；不额外等会读到上一个方向的数据（实测踩过）
      steps.push({ type: 'waitMs', input: { ms: p.tabSettleMs || 8000 } })
    }
    // labels 模式：该方向不是表格，而是"标签 + 邻近文本"的卡片（实测拼多多资金中心提交发票页）
    if (sec.labels?.length) {
      for (const l of sec.labels) {
        steps.push({
          type: 'readLabelValue',
          input: {
            label: l.label,
            // 一个标签一条快照，collect 侧按 `${metricKey}.${key}` 拼成该方向的一行
            metric: `${sec.metricKey}.${l.key}`,
            // 这些值不是数字（公司名 / "2026年05/06月"）→ 原样取文本，别做数值抽取
            allowText: true,
            maxValueLen: 120,
            ...(p.deep ? { deep: true } : {})
          },
          timeoutMs: 20000
        })
      }
      return
    }
    // 实测条数为 0 的方向 = **它本来就没有数据表**（不是"抓失败"）：
    // 允许空表（落 0 条快照，界面显示"0 条"），别让它把整轮采集判失败。
    const verifiedEmpty = sec.measuredRows === 0
    steps.push({
      type: 'readTable',
      input: {
        selector: p.tableSelector,
        // 每个方向一条独立指标名，互不覆盖
        metric: sec.metricKey,
        keepRows: true,
        pickByHeader: sec.pickByHeader,
        // **方向校验**：读到的表头必须包含该方向的实测列名。方向没切成功时，
        // 读到的会是上一个方向的表 → 这里如实失败，而不是把上一个方向的数据当成本方向的上报。
        expectHeaders: Object.keys(sec.headerMap),
        ...(sec.rejectHeaders ? { rejectHeaders: sec.rejectHeaders } : {}),
        ...(verifiedEmpty ? { emptyOk: true } : {}),
        ...(sec.mergeHeaderTable ? { mergeHeaderTable: true } : {}),
        ...(p.deep ? { deep: true } : {})
      },
      timeoutMs: 30000
    })
    // 方向之间留一次小等待（同一页连续读，给渲染留余量）
    if (i < p.sections.length - 1 && !p.sections[i + 1].tabText && !p.sections[i + 1].pageUrl) {
      steps.push({ type: 'waitMs', input: { ms: 1500 } })
    }
  })
  return steps
}
