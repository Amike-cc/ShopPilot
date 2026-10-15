import { describe, expect, it } from 'vitest'
import { pickSectionRows } from '@shared/invoice-snapshot'

/**
 * 发票方向快照的读取规则（2026-10-14 审查 A2 的回归测试）。
 *
 * 事故形态：采集某一轮"没读到"（页签没切成功）时，旧实现写了一条空数组快照，
 * 读取侧取最新一条 → 上一次真采到的行**无声消失**，而那一轮还报 succeeded。
 * 现在采集侧写的是标记 `{empty:true,why}`，读取侧必须"跳过标记、保住真数据、并把原因说出来"。
 */
describe('发票方向快照：标记不该覆盖真数据', () => {
  const rowSnap = (rows: any[], capturedAt: number) => ({ value: rows, capturedAt })
  const marker = (why: string, capturedAt: number) => ({ value: { empty: true, why, at: capturedAt }, capturedAt })

  it('只有一份数组快照 → 用它，没有提示', () => {
    const pick = pickSectionRows([rowSnap([['单号'], ['A1']], 1000)])
    expect(pick.rows).toEqual([['单号'], ['A1']])
    expect(pick.capturedAt).toBe(1000)
    expect(pick.emptyNote).toBeNull()
    expect(pick.emptyAt).toBeNull()
  })

  it('**标记比数据新**（这次没读到）→ 保住上一次的行，并带出原因与时刻', () => {
    const pick = pickSectionRows([
      marker('页面上是另一方向（含「账单名称」列）的表，本方向没有自己的数据', 2000),
      rowSnap([['单号'], ['A1']], 1000)
    ])
    expect(pick.rows).toEqual([['单号'], ['A1']])       // ← 关键：没有被清空
    expect(pick.capturedAt).toBe(1000)                   // ← 时间戳仍是**数据**的时间
    expect(pick.emptyNote).toContain('另一方向')
    expect(pick.emptyAt).toBe(2000)
  })

  it('数据比标记新（后来成功采过）→ 旧失败不再挂在界面上', () => {
    const pick = pickSectionRows([
      rowSnap([['单号'], ['A2']], 3000),
      marker('页签没切成功', 2000)
    ])
    expect(pick.rows).toEqual([['单号'], ['A2']])
    expect(pick.capturedAt).toBe(3000)
    expect(pick.emptyNote).toBeNull()
  })

  it('只有标记（这个方向从来没成功读过）→ 没有行，但有原因（界面能说"这次没读到"）', () => {
    const pick = pickSectionRows([marker('页面上没有该选择器的表格', 5000)])
    expect(pick.rows).toEqual([])
    expect(pick.capturedAt).toBeNull()
    expect(pick.emptyNote).toBe('页面上没有该选择器的表格')
    expect(pick.emptyAt).toBe(5000)
  })

  it('标记连原因都没写 → 给一句通用说明，不显示 undefined', () => {
    const pick = pickSectionRows([{ value: { empty: true }, capturedAt: 1 }])
    expect(pick.emptyNote).toBeTruthy()
    expect(pick.emptyNote).not.toContain('undefined')
  })

  it('多个数组快照只取最新那一份；没有快照时是干净的空结果', () => {
    const pick = pickSectionRows([rowSnap([['新']], 900), rowSnap([['旧']], 100)])
    expect(pick.rows).toEqual([['新']])
    expect(pick.capturedAt).toBe(900)
    expect(pickSectionRows([])).toEqual({
      rows: [], capturedAt: null, emptyNote: null, emptyAt: null,
      expectedEmpty: false, expectedEmptyAt: null
    })
  })

  /**
   * 2026-10-14 审查 BUG：预期内的空（档案声明该方向本来就没表 → 采集步骤带 emptyOk）
   * 以前和"这次真没读到"共用 emptyNote，界面于是把「微信小店·给买家开票」「抖店·达人给我开票」
   * 渲染成「本次没读到」，tooltip 还写着"下面显示的是上一次成功采集的数据"——它们从来没有过数据。
   */
  it('预期内的空不进 emptyNote（不渲染成「本次没读到」），只在 expectedEmpty 留痕', () => {
    const expected = pickSectionRows([{ value: { empty: true, why: '页面上没有该选择器的表格', expected: true }, capturedAt: 800 }])
    expect(expected.emptyNote).toBeNull()
    expect(expected.emptyAt).toBeNull()
    expect(expected.expectedEmpty).toBe(true)
    expect(expected.expectedEmptyAt).toBe(800)
  })

  it('真正"这次没读到"（没有 expected 标记）照旧如实报警', () => {
    const unexpected = pickSectionRows([{ value: { empty: true, why: '页签没切成功' }, capturedAt: 800 }])
    expect(unexpected.emptyNote).toBe('页签没切成功')
    expect(unexpected.emptyAt).toBe(800)
    expect(unexpected.expectedEmpty).toBe(false)
  })

  it('预期内的空不覆盖真数据（旧写法把两者混在一起时最容易出静默错）', () => {
    const pick = pickSectionRows([
      { value: { empty: true, why: '页面上没有该选择器的表格', expected: true }, capturedAt: 900 },
      rowSnap([['真数据']], 500)
    ])
    // 行数据照旧取最新那一份**数组**快照（标记绝不覆盖它）
    expect(pick.rows).toEqual([['真数据']])
    expect(pick.capturedAt).toBe(500)
    // 不报警：预期内的空不该说"本次没读到、下面是上次数据"
    expect(pick.emptyNote).toBeNull()
    // expectedEmpty 的语义是"**最新一次**采集是预期内的空"——与是否留有旧数据无关
    expect(pick.expectedEmpty).toBe(true)
    expect(pick.expectedEmptyAt).toBe(900)
  })

  it('非数组又非标记的脏值（比如历史版本写的行数）不会当数据用，也不会报错', () => {
    const pick = pickSectionRows([{ value: 37, capturedAt: 700 }])
    expect(pick.rows).toEqual([])
    expect(pick.emptyNote).toBeNull()
  })
})
