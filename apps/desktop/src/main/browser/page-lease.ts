/**
 * 后台采集"借用店铺页面"的租约账本。
 *
 * 背景（2026-10-02 用户实报「采集任务完成后关闭网页，优化占用」）：无人值守的采集
 * （经营数据每 10 分钟一轮、发票每 3 小时一轮）为了拿到页面句柄会**自己**把店铺浏览器
 * 后台开起来（`display:false`，不抢用户当前页），但从来没有人关它——一轮轮下来每个店铺
 * 都留下一个常驻渲染进程。这个账本回答的唯一问题是：
 *
 *   **这一轮采集结束后，页面到底能不能关？**
 *
 * 判据只有三条，缺一不可（任何一条不满足就保持开着）：
 *   ① 页面是**我们**为后台采集开的（不是用户自己开着的）；
 *   ② 已经没有任何借用者（引用计数归零，多个采集并发用同一个页面时不会被先结束的那个关掉）；
 *   ③ 期间**用户没有接手**（没有把它显示出来看过）——用户看过的页面归用户，
 *      本次采集归还不当着他的面关掉。店铺级冷休眠由 window-manager 独立决定。
 *
 * 这里刻意做成不碰 Electron、不碰 DB 的纯状态机：页面开关的副作用留在 window-manager，
 * 决策留在本模块，这样"什么时候能关"可以被单测逐条钉死。
 */
export class StorePageLeases {
  /** storeId → 借用者数量（>0 表示还有后台采集在用这个页面） */
  private readonly borrowed = new Map<string, number>()
  /** 页面是**我们**为后台采集开的（用户自己开的页面不进这个集合） */
  private readonly backgroundOpened = new Set<string>()
  /** 用户接手过的页面（显示过/自己打开过）：本次租约归还不关 */
  private readonly userOwned = new Set<string>()

  /**
   * 借用一个店铺页面。
   * @param openedByUs 这次借用是不是**由我们打开的**（页面本来就没开）。
   *                   页面本来就开着时传 false：那多半是用户自己在用，绝不能因为一次采集结束就关掉。
   */
  borrow(storeId: string, openedByUs: boolean): void {
    this.borrowed.set(storeId, (this.borrowed.get(storeId) || 0) + 1)
    if (openedByUs) this.backgroundOpened.add(storeId)
  }

  /**
   * 归还一个借用。返回 true = **可以关**（三条判据全满足）；false = 保持开着。
   * 返回 true 时账本里的"后台开的"标记会一并清掉，避免重复关闭。
   */
  release(storeId: string): boolean {
    const count = this.borrowed.get(storeId) || 0
    if (count <= 0) {
      // 页面已经被别的路径关掉了（用户点关闭、删店等）：归还只是清账，不再触发关闭
      this.backgroundOpened.delete(storeId)
      return false
    }
    const left = count - 1
    if (left > 0) {
      this.borrowed.set(storeId, left)
      return false
    }
    this.borrowed.delete(storeId)
    if (!this.backgroundOpened.has(storeId)) return false
    if (this.userOwned.has(storeId)) {
      // 用户接手过：本次采集结束不关
      this.backgroundOpened.delete(storeId)
      return false
    }
    this.backgroundOpened.delete(storeId)
    return true
  }

  /** 用户接手（显示店铺 / 从界面打开）：本次后台租约归还不会关闭它。 */
  claimByUser(storeId: string): void {
    this.userOwned.add(storeId)
  }

  /** 页面已经被关闭（任何路径）：清掉该店铺的全部账，避免下次借用拿着旧状态做判断。 */
  forget(storeId: string): void {
    this.borrowed.delete(storeId)
    this.backgroundOpened.delete(storeId)
    this.userOwned.delete(storeId)
  }

  /** 当前是否还有后台采集在用这个页面（诊断用）。 */
  isBorrowed(storeId: string): boolean {
    return (this.borrowed.get(storeId) || 0) > 0
  }

  /** 只读快照：内存诊断要能看出"页面为什么还开着"。 */
  snapshot(): Array<{ storeId: string; borrowers: number; backgroundOpened: boolean; userOwned: boolean }> {
    const ids = new Set<string>([...this.borrowed.keys(), ...this.backgroundOpened, ...this.userOwned])
    return [...ids].sort().map(storeId => ({
      storeId,
      borrowers: this.borrowed.get(storeId) || 0,
      backgroundOpened: this.backgroundOpened.has(storeId),
      userOwned: this.userOwned.has(storeId)
    }))
  }

  /** 测试与应用退出清理用。 */
  reset(): void {
    this.borrowed.clear()
    this.backgroundOpened.clear()
    this.userOwned.clear()
  }
}
