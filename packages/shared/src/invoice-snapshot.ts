/**
 * 「该方向的快照怎么读」——发票中心读取侧的纯函数（可单测）。
 *
 * 背景（2026-10-14 审查 A2）：采集方向失败时（页签没切成功/读到别的方向的表/页面没加载完），
 * 旧实现会写一条 **空数组** 快照。读取侧"每店每指标取最新一条"于是把空数组当成最新数据 →
 * 上一次真采到的行**无声消失**，而那一轮运行还是 succeeded、界面时间戳还是新的。
 *
 * 现在采集侧改成写一条**带原因的标记**（`{ empty: true, why }`），这里负责：
 *   · 行数据取**最新的一份数组快照**（标记不参与、也绝不覆盖真数据）；
 *   · 标记比数组新时，把原因与时刻带出来，界面如实说明"这一次没读到，下面是上一次的数据"；
 *   · 标记比数组旧（后来成功采过）就忽略它——旧失败不该一直挂在界面上。
 *
 * 为什么单独成文件：读取侧在 overview-service（引 electron/db，单测跑不起来），
 * 而"取哪一份"正是最容易出静默错的地方，抽成纯函数才钉得住。
 */

export interface SnapshotLike {
  value: unknown
  capturedAt?: number | null
}

export interface SectionRowsPick {
  /** 最新的数组快照（真数据）；没有就是空数组 */
  rows: unknown[][]
  /** 该数据的采集时刻（不是"这次跑"的时刻） */
  capturedAt: number | null
  /** 比数据更新的那次"没读到"的原因；没有则为 null */
  emptyNote: string | null
  /** 那次"没读到"发生的时刻 */
  emptyAt: number | null
  /**
   * 最新那次空是**预期内**的（档案声明该方向本来就没有表 / 本来就可能没有账单）。
   *
   * 为什么要单独标出来（2026-10-14 审查 BUG）：以前预期内的空与"这次真没读到"共用
   * `emptyNote`，界面于是把「微信小店·给买家开票」「抖店·达人给我开票」这类
   * **本来就无表**的方向渲染成「本次没读到」，tooltip 还写着"下面显示的是上一次成功采集的数据"
   * ——可它们从来没有过数据，那句话是假的；店铺还会因此落进「有问题」筛选。
   * 现在预期内的空不再进 `emptyNote`，只在这里留个痕迹供诊断。
   */
  expectedEmpty: boolean
  /** 那次"预期内空"的时刻 */
  expectedEmptyAt: number | null
}

/** 「没读到」的标记（采集侧写在快照里的形状） */
interface EmptyMarker {
  empty: true
  why?: unknown
  at?: unknown
  /**
   * 这一次的空是**预期内**的：采集步骤带了 `emptyOk`（档案已声明该方向没有数据表）。
   * 缺省 false（= 这次真的没读到，要如实报警）。
   */
  expected?: unknown
}

/** 这一条是不是"没读到"的标记（而不是表行数组） */
function isEmptyMarker(value: unknown): value is EmptyMarker {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as { empty?: unknown }).empty === true
}

/** 快照值是不是"一行行的表数据" */
function isRowArray(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.every(row => Array.isArray(row))
}

/**
 * @param snaps 同一 (店铺, 指标) 的快照，**新的在前**
 */
export function pickSectionRows(snaps: readonly SnapshotLike[]): SectionRowsPick {
  let rows: unknown[][] = []
  let capturedAt: number | null = null
  let rowsSeen = false
  let emptyNote: string | null = null
  let emptyAt: number | null = null
  let expectedEmpty = false
  let expectedEmptyAt: number | null = null

  for (const snap of snaps) {
    if (isRowArray(snap.value)) {
      if (rowsSeen) continue          // 只要最新那一份数组
      rows = snap.value
      capturedAt = snap.capturedAt ?? null
      rowsSeen = true
      continue
    }
    if (isEmptyMarker(snap.value)) {
      // 只看**最新**那一条空标记（先遇到的 = 更新的那次）；被数据盖过的旧标记不算
      if (rowsSeen || emptyNote || expectedEmpty) continue
      if (snap.value.expected === true) {
        // 预期内的空（档案声明本来就没表）：不留报警，只记痕迹
        expectedEmpty = true
        expectedEmptyAt = snap.capturedAt ?? null
      } else {
        emptyNote = String(snap.value.why || '本次没有读到（页面/页签未就绪）')
        emptyAt = snap.capturedAt ?? null
      }
    }
  }
  return { rows, capturedAt, emptyNote, emptyAt, expectedEmpty, expectedEmptyAt }
}
