/**
 * 发布台账的**状态词表**（方案 §7.4 / §7.8）。
 *
 * ⚠️ 为什么要有这个文件（2026-10-01 实测踩到）：
 * 这个项目里一度存在**三套互不一致的状态命名**：
 *
 *   · 规则层 `BatchItemState`：`pending | running | awaiting_human | confirmed | needs_review | failed | skipped`
 *   · 仓储 SQL 里实际写的：`prechecking | filling | fill_partial | verifying | awaiting_human | …`
 *   · 库里的实际值：`awaiting_human | confirmed | needs_review | precheck_failed`
 *
 * 后果是我给「全部暂停」写的 SQL 过滤了 `status = 'in_progress'` —— 一个**在任何一套里都不存在**的值，
 * 于是它永远命中 0 行、**静默空操作**（不报错、不生效）。
 *
 * 所以把词表收敛到这一个文件，并用源码扫描测试（`tests/unit/product-status-vocabulary.test.ts`）
 * 保证仓储 SQL 里只出现这里的名字 —— 再写错就会**测试失败**，而不是静默失效。
 */

/** 台账里一个发布项**可能出现的全部状态**。仓储 SQL 只许用这些名字。 */
export const PUBLISH_ITEM_STATES = [
  // 还没开始
  'pending',
  // **"正在跑"的四个中间态** —— 注意它们不叫 running，这是实测出来的真实命名
  'prechecking',
  'filling',
  'fill_partial',
  'verifying',
  // 人工交接点（**不是**"正在跑"：它在等人，不该被"暂停"冲掉）
  'awaiting_human',
  // 终态
  'confirmed',
  'needs_review',
  'failed',
  'precheck_failed',
  'skipped'
] as const

export type PublishItemState = typeof PUBLISH_ITEM_STATES[number]

/**
 * **"正在跑"的状态集合** —— 「全部暂停」只退回这些。
 *
 * `awaiting_human` **故意不在这里**：它是人工交接点，暂停批次不该把人正在看的交接点抹掉。
 */
export const IN_FLIGHT_PUBLISH_STATES = ['prechecking', 'filling', 'fill_partial', 'verifying'] as const

/** 人工交接点（等用户确认，既不算"在跑"也不算终态）。 */
export const HUMAN_GATE_PUBLISH_STATES = ['awaiting_human'] as const

/**
 * **台账状态 → 规则层 `BatchItemState`** 的显式映射。
 *
 * ⚠️ 为什么必须有这个函数（2026-10-01 实测踩到）：
 * 服务层原来写着"台账里的 status 与规则层的状态同名，直接映射"，然后做了一次 `as` 强转 ——
 * **那句话是错的**，两套词表并不同名：
 *
 *   · 台账里的失败叫 `precheck_failed`，规则层统计的是 `failed` → **强转后失败项被完全漏统计**
 *   · 台账里的"正在跑"叫 `prechecking/filling/fill_partial/verifying`，规则层是 `running` → 同样漏掉
 *
 * 后果是**批量进度会漏报失败**（界面显示"失败 0"，实际有失败项）——
 * 这违反了本项目"不许撒谎"的底线。所以改成**显式映射**，认不出来的状态**按 failed 处理**
 * （保守：宁可多报一个失败让人去看，也不要悄悄吞掉）。
 */
export function toBatchItemState(status: string):
  'pending' | 'running' | 'awaiting_human' | 'confirmed' | 'needs_review' | 'failed' | 'skipped' | 'discarded' {
  switch (status) {
    case 'pending': return 'pending'
    case 'prechecking':
    case 'filling':
    case 'fill_partial':
    case 'verifying': return 'running'
    case 'awaiting_human': return 'awaiting_human'
    case 'confirmed': return 'confirmed'
    case 'needs_review': return 'needs_review'
    case 'failed':
    case 'precheck_failed': return 'failed'
    case 'skipped': return 'skipped'
    case 'discarded': return 'discarded'
    // 认不出来的一律当失败：**不静默吞掉**
    default: return 'failed'
  }
}
