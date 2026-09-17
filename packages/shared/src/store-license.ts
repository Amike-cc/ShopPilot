/**
 * 店铺「营业执照」的归一化、归组与筛选（发票中心与导出共用）。
 *
 * 为什么要营业执照这一维：发票是**按开票主体**开的，不是按平台账号开的。
 * 同一个营业执照下常常挂好几家店（同公司开了抖店 + 快手 + 微信小店），
 * 只看"店铺"会把一个主体的票拆成好几份，对不上账；而"未填写"的店也不能被悄悄混进某个主体里。
 *
 * 归组规则（**代码优先**）：
 *   1. 填了统一社会信用代码的 → 按代码归组（名称写法、大小写、中间带的空格不同也能归到一起）；
 *   2. 没填代码但名称与某个"有代码的主体"完全相同 → 归进那个主体（用户常常先填名称、
 *      后来才补代码；不归到一起就会出现两个同名胶囊各 1 家，看起来像坏了）；
 *   3. 没填代码、名称也不匹配 → 按归一化名称归组；
 *   4. 什么都没有 → `NO_LICENSE_KEY`（界面显示"未填写"），**不**与任何真实主体合并。
 *
 * 注意 2 带来的后果：一个店铺属于哪一组是**看整份列表**才能定的（"这家没填代码，
 * 但它和那家同名、那家有代码"），所以对外给的是 `keyByStore` 这张表，
 * 界面上的筛选必须用它——不能各店各算一遍 `licenseKeyOf`，否则胶囊写"2 家"却只筛出 1 家。
 *
 * 这里全是纯函数，不碰数据库：主进程（导出）与渲染层（筛选）各取一份同样的结果。
 */

/** 未填写营业执照的桶（不是真实主体，界面上单独列，且可被单独筛出来补录） */
export const NO_LICENSE_KEY = '__none__'

export interface StoreLicenseFields {
  licenseName?: string | null
  licenseNo?: string | null
}

/** 统一社会信用代码：去掉空白/连字符并转大写（实测用户会从执照上连空格一起复制过来） */
export function normalizeLicenseNo(value: unknown): string {
  return String(value ?? '').replace(/[\s-]/g, '').toUpperCase()
}

/** 主体名称：去首尾空白 + 内部连续空白压成一个（半角/全角空格都归一） */
export function normalizeLicenseName(value: unknown): string {
  return String(value ?? '').replace(/[\s\u3000]+/g, ' ').trim()
}

/**
 * 单看一家店时的归组 key：代码 > 名称 > 未填写。
 * 只用于"这家自己就能决定"的场景（如导出时判定主体）；界面上的归组与筛选请用 `keyByStore`。
 */
export function licenseKeyOf(store: StoreLicenseFields | null | undefined): string {
  const no = normalizeLicenseNo(store?.licenseNo)
  if (no) return no
  const name = normalizeLicenseName(store?.licenseName)
  if (name) return name.toLowerCase()
  return NO_LICENSE_KEY
}

/** 界面展示用的主体名（没有名称时退化成代码；都没有 = 空串，由界面写"未填写"） */
export function licenseLabelOf(store: StoreLicenseFields | null | undefined): string {
  return normalizeLicenseName(store?.licenseName) || normalizeLicenseNo(store?.licenseNo) || ''
}

export interface LicenseGroup extends StoreLicenseFields {
  /** 分组 key（代码 / 小写名称 / NO_LICENSE_KEY） */
  key: string
  /** 显示名（未填写时为空串） */
  label: string
  /** 归一化后的统一社会信用代码（该组里没人填就是空串） */
  no: string
  storeIds: string[]
  storeCount: number
}

export interface LicenseGrouping {
  /** 排序后的分组：店铺多的在前，名称序，`未填写`永远最后（它是要被清理的，不是主角） */
  groups: LicenseGroup[]
  /** storeId → 分组 key（**筛选用这一张表**，理由见文件头） */
  keyByStore: Map<string, string>
  /** 有没有店铺还没填营业执照（界面据此决定要不要显示"未填写"胶囊） */
  hasMissing: boolean
}

/**
 * 把店铺按营业执照归组。`stores` 必须带 id（渲染层用店铺 id 反查归属）。
 */
export function groupStoresByLicense(stores: Array<StoreLicenseFields & { id: string }>): LicenseGrouping {
  // 第一遍：有代码的店先定组，并把"名称 → 组"记下来，供只有名称的店认领
  const keyByStore = new Map<string, string>()
  const groups = new Map<string, LicenseGroup>()
  const keyByName = new Map<string, string>()

  const ensure = (key: string): LicenseGroup => {
    const hit = groups.get(key)
    if (hit) return hit
    const created: LicenseGroup = {
      key, label: '', no: '', licenseName: null, licenseNo: null, storeIds: [], storeCount: 0
    }
    groups.set(key, created)
    return created
  }
  const absorb = (g: LicenseGroup, s: StoreLicenseFields & { id: string }): void => {
    g.storeIds.push(s.id)
    g.storeCount++
    // 同一主体里只要有一家填了名称/代码，就用它当展示信息（先填的那家可能只填了名称）
    if (!g.no) g.no = normalizeLicenseNo(s.licenseNo)
    if (!g.label) g.label = licenseLabelOf(s)
    if (!g.licenseName) g.licenseName = normalizeLicenseName(s.licenseName) || null
    if (!g.licenseNo) g.licenseNo = normalizeLicenseNo(s.licenseNo) || null
  }

  for (const s of stores) {
    const no = normalizeLicenseNo(s.licenseNo)
    if (!no) continue
    const g = ensure(no)
    absorb(g, s)
    keyByStore.set(s.id, no)
    const name = normalizeLicenseName(s.licenseName).toLowerCase()
    if (name && !keyByName.has(name)) keyByName.set(name, no)
  }

  // 第二遍：没有代码的店——名称与某个有代码的主体完全一致就并进去，否则按名称单独成组
  for (const s of stores) {
    if (keyByStore.has(s.id)) continue
    const name = normalizeLicenseName(s.licenseName).toLowerCase()
    const key = name ? (keyByName.get(name) || name) : NO_LICENSE_KEY
    keyByStore.set(s.id, key)
    absorb(ensure(key), s)
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.key === NO_LICENSE_KEY) return 1
    if (b.key === NO_LICENSE_KEY) return -1
    if (b.storeCount !== a.storeCount) return b.storeCount - a.storeCount
    return a.label.localeCompare(b.label, 'zh-CN')
  })
  // 未填写的组不参与"真实主体"的排序，但没有名称也没有代码的店仍要能被筛出来
  return { groups: ordered, keyByStore, hasMissing: ordered.some(g => g.key === NO_LICENSE_KEY) }
}
