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
 */export function groupStoresByLicense(stores: Array<StoreLicenseFields & { id: string }>): LicenseGrouping {
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

/**
 * 按开票主体把**行**筛一道（发票中心屏上的筛选与「导出待开票 CSV」共用这一份规则）。
 *
 * 为什么导出也要走它：导出的表是拿去报税/交代账的，代账按主体分账——用户在屏上点了某个主体
 * 再导出，拿到的就该是那个主体的行；否则 A 公司的清单里会混进别家公司的单号/金额/税号。
 *
 * 为什么必须复用 `groupStoresByLicense`：一家店属于哪个主体**要看整份列表**才能定
 * （没填代码但和有代码的那家同名的店，要并进那个主体），各店各算一遍会出现
 * "胶囊写 2 家、筛出来只有 1 家"（见文件头）。
 *
 * @param rows 每店一行、带 storeId 与营业执照字段（发票中心的行就是这个形状）
 * @param licenseKey 分组 key（代码 / 小写名称 / NO_LICENSE_KEY）；**空 = 不筛选（全部）**
 */
export function filterRowsByLicenseKey<T extends { storeId: string } & StoreLicenseFields>(
  rows: readonly T[],
  licenseKey: string | null | undefined
): T[] {
  const key = String(licenseKey ?? '').trim()
  if (!key) return [...rows]
  const { keyByStore } = groupStoresByLicense(rows.map(r => ({
    id: r.storeId,
    licenseName: r.licenseName ?? null,
    licenseNo: r.licenseNo ?? null
  })))
  return rows.filter(r => keyByStore.get(r.storeId) === key)
}

/** 从平台读回来的主体信息（形状与 store_snapshots 的 entity.* 指标对齐） */
export interface FetchedEntity {
  name?: string | null
  no?: string | null
}

/**
 * 导出范围标签（保存框标题 / 默认文件名 / 成功提示共用）。
 *
 * 为什么不直接用 key：**只填了统一社会信用代码的主体**（名称留空）在界面上就是拿代码当标签
 * （见 licenseLabelOf），这里若只看名称就会得到空串 —— 用户"选中某个主体导出"，却被告知导的是
 * "全部主体"，文件名也退化成不带主体的 `待开票清单-日期.csv`（两个主体连导还会撞同名）。
 * 取不到名称就退到代码，再退到 key 本身。
 */
export function licenseScopeLabel(rows: readonly StoreLicenseFields[], licenseKey: string | null | undefined): string {
  const key = String(licenseKey ?? '').trim()
  if (!key) return ''
  if (key === NO_LICENSE_KEY) return '未填写营业执照'
  const name = rows.map(r => normalizeLicenseName(r.licenseName)).find(Boolean)
  if (name) return name
  const no = rows.map(r => normalizeLicenseNo(r.licenseNo)).find(Boolean)
  if (no) return no
  return key
}

/**
 * 单个字段的对照结论。
 *   - `platform-empty`：平台**没读到**这个字段 → 未比对（既不是一致，也不是不一致）
 *   - `platform-placeholder`：平台这一行写的是「无」这类**占位文案**（实测拼多多个人店铺）
 *     → 不是可用的主体信息，也不该被说成"读到了"
 *   - `store-empty`：平台读到了真值、店里还空着 → 待补录（不是冲突；decideLicenseWrite 会直接填上）
 *   - `match` / `mismatch`：两边都有值时的比对结果
 */
export type EntityFieldVerdict = 'platform-empty' | 'platform-placeholder' | 'store-empty' | 'match' | 'mismatch'

export interface StoreEntityComparison {
  name: EntityFieldVerdict
  no: EntityFieldVerdict
}

/** 这一行的值是不是"没有值"的占位文案（与写回判定同一份规则，界面显示也用） */
export function isPlaceholderLicenseValue(v: unknown): boolean {
  const s = String(v ?? '').trim()
  return !!s && (PLACEHOLDER_RE.test(s) || PLACEHOLDER_RE.test(s.replace(/[\s-]/g, '')))
}

/**
 * 把「平台读到的主体」逐字段与「店铺已填」比一遍（界面展示与核对用；写不写由 decideLicenseWrite 定）。
 *
 * 为什么必须逐字段、且把"平台没读到"和"店里空着"分开说：这两件事最容易被糊成一句
 * "一致/不一致"——把"店里还没填代码"说成冲突会让人去改一个本来没错的主体；把"平台只读到名称"
 * 说成"主体一致"则是拿没比对过的字段打包票（税号恰恰是最不能想当然的那个）。
 * 比的是归一化后的值（大小写、空白、连字符都归一），与 decideLicenseWrite 同一套口径。
 */
export function compareStoreEntity(
  store: StoreLicenseFields | null | undefined,
  fetched: FetchedEntity | null | undefined
): StoreEntityComparison {
  const cmp = (platformValue: unknown, storeValue: unknown, norm: (v: unknown) => string): EntityFieldVerdict => {
    const p = norm(platformValue)
    if (!p) return 'platform-empty'
    // 占位文案（实测「无」）不是主体信息——显示与写回都按"没有可用值"处理
    if (isPlaceholderLicenseValue(platformValue)) return 'platform-placeholder'
    const s = norm(storeValue)
    if (!s) return 'store-empty'
    return p === s ? 'match' : 'mismatch'
  }
  return {
    // 名称比对按小写（与 decideLicenseWrite 的 existing.toLowerCase() === next.toLowerCase() 一致）
    name: cmp(fetched?.name, store?.licenseName, v => normalizeLicenseName(v).toLowerCase()),
    no: cmp(fetched?.no, store?.licenseNo, v => normalizeLicenseNo(v))
  }
}

/**
 * 界面上那一句「平台读到的主体 vs 已填」的结论（发票中心行内用）。
 * 说得比数据少不行（用户没法核对），说得比数据多也不行（"一致"三个字只留给**比过的**字段）。
 */
export function entityVerdictText(
  store: StoreLicenseFields | null | undefined,
  fetched: FetchedEntity | null | undefined
): string {
  const cmp = compareStoreEntity(store, fetched)
  const fieldName = (field: 'name' | 'no') => (field === 'name' ? '名称' : '信用代码')
  const readFields = (['name', 'no'] as const)
    .filter(f => cmp[f] === 'match' || cmp[f] === 'mismatch' || cmp[f] === 'store-empty')
    .map(fieldName)
  const placeholderFields = (['name', 'no'] as const).filter(f => cmp[f] === 'platform-placeholder').map(fieldName)
  const placeholderNote = placeholderFields.length
    ? `平台${placeholderFields.join('、')}这一行写的是「无」这类占位文案（没有可用的主体信息）`
    : ''

  if (!normalizeLicenseName(store?.licenseName) && !normalizeLicenseNo(store?.licenseNo)) {
    if (readFields.length) {
      return `店铺还没填主体（平台读到了${readFields.join('和')}，可在上方点「获取主体营业执照」填入）` + (placeholderNote ? `；${placeholderNote}` : '')
    }
    return placeholderNote ? `店铺还没填主体；${placeholderNote}，不会写入店铺` : '店铺还没填主体，可在上方点「获取主体营业执照」填入'
  }

  const mismatches = (['name', 'no'] as const)
    .filter(f => cmp[f] === 'mismatch')
    .map(f => f === 'name'
      ? `名称（已填「${store?.licenseName}」／平台「${fetched?.name}」）`
      : `信用代码（已填「${store?.licenseNo}」／平台「${fetched?.no}」）`)
  if (mismatches.length) return `与已填的不一致：${mismatches.join('；')}——核对清楚再改，自动写入不会覆盖你的填写`

  const parts: string[] = []
  const matched = (['name', 'no'] as const).filter(f => cmp[f] === 'match').map(fieldName)
  const canFill = (['name', 'no'] as const).filter(f => cmp[f] === 'store-empty').map(fieldName)
  const notRead = (['name', 'no'] as const).filter(f => cmp[f] === 'platform-empty').map(fieldName)
  if (matched.length) parts.push(`${matched.join('、')}与已填一致`)
  if (canFill.length) parts.push(`${canFill.join('、')}平台读到了、店里还空着（可补录）`)
  if (placeholderNote) parts.push(`${placeholderNote}（未比对）`)
  if (notRead.length) parts.push(`${notRead.join('、')}平台没读到（未比对）`)
  return parts.join('；')
}

export interface LicenseWriteDecision {
  /** fill=有可写字段；same=与已填一致；conflict=读到的与已填不同（不覆盖）；nothing=读到的东西都不可用 */
  action: 'fill' | 'same' | 'conflict' | 'nothing'
  /** 只含**该写**的字段（已填且不一致的字段绝不会出现在这里） */
  write: { licenseName?: string; licenseNo?: string }
  /** 读到了但与已填不一致（界面要把两边都摆出来，让用户自己判断该信谁） */
  conflicts: Array<{ field: 'licenseName' | 'licenseNo'; existing: string; fetched: string }>
  /** 读到了但**不可用**（平台掩码、形态不对）——绝不能写进库 */
  rejected: Array<{ field: 'licenseName' | 'licenseNo'; raw: string; why: string }>
  /** 平台页面上一个字都没读到（个人店铺没营业执照，或页面改版）——界面要把这两种可能都说出来 */
  fetchedNothing?: boolean
}

/** 平台把证件号打码了（实测微信「注册号/统一社会信用代码」= 9233**********D310） */
const MASK_RE = /[*＊·•]{2,}/

/**
 * "这一行没有值"的占位文案（实测拼多多个人店铺的「营业执照信息」四行都写「无」）。
 *
 * 为什么必须单独挡：这类文案既不是掩码、长度也合法，会一路通过校验被写成"主体名称=无"——
 * 那比不填更糟（申报表上会赫然出现一个假主体）。宁可少填，不可填错。
 */
const PLACEHOLDER_RE = /^(无|没有|暂无|暂无信息|暂无数据|未填写|未登记|未认证|未查询到|不适用|不涉及|保密|未知|待完善|空|null|nil|n\/a|na|none|-{1,2}|—{1,2}|\/|\.)$/i

/**
 * 决定「平台读到的主体」要不要写进店铺营业执照。规则（宁可少填，不可填错）：
 *  - 掩码值、形态不合法（信用代码非 15/18 位字母数字）→ **不写**，如实说明原因；
 *  - 店铺该字段**空着** → 写入（这正是"自动获取主体"要的效果）；
 *  - 已填且与平台一致 → 不动，报"一致"；
 *  - 已填但与平台不同 → **不覆盖**，把两个值都回报，由用户判断（错一个公司就是错票）。
 */
export function decideLicenseWrite(
  store: StoreLicenseFields | null | undefined,
  fetched: FetchedEntity | null | undefined
): LicenseWriteDecision {
  const write: LicenseWriteDecision['write'] = {}
  const conflicts: LicenseWriteDecision['conflicts'] = []
  const rejected: LicenseWriteDecision['rejected'] = []

  const rawName = normalizeLicenseName(fetched?.name)
  const rawNo = normalizeLicenseNo(fetched?.no)

  const checkName = (): string | null => {
    if (!rawName) return null
    if (PLACEHOLDER_RE.test(rawName)) { rejected.push({ field: 'licenseName', raw: rawName, why: '平台这一行写的是「' + rawName + '」——是占位文案，不是真的主体名称' }); return null }
    if (MASK_RE.test(rawName)) { rejected.push({ field: 'licenseName', raw: rawName, why: '平台对主体名称打了码' }); return null }
    if (rawName.length > 120) { rejected.push({ field: 'licenseName', raw: rawName.slice(0, 40) + '…', why: '名称过长，疑似读到整块容器文本' }); return null }
    return rawName
  }
  const checkNo = (): string | null => {
    if (!rawNo) return null
    if (PLACEHOLDER_RE.test(rawNo)) { rejected.push({ field: 'licenseNo', raw: rawNo, why: '平台这一行写的是「' + rawNo + '」——是占位文案，不是真的证件号' }); return null }
    if (MASK_RE.test(rawNo)) { rejected.push({ field: 'licenseNo', raw: rawNo, why: '平台对统一社会信用代码打了码（只显示头尾）' }); return null }
    if (!/^(?:[0-9A-Z]{18}|[0-9]{15})$/.test(rawNo)) { rejected.push({ field: 'licenseNo', raw: rawNo, why: '不是 18 位（或旧税号 15 位）的字母数字' }); return null }
    return rawNo
  }

  const name = checkName()
  const no = checkNo()
  // 一个字都没读到：可能是个人店铺（本来没有营业执照），也可能是页面改版——
  // 两种可能都由界面照实说出来，绝不写任何值
  const fetchedNothing = !rawName && !rawNo

  const settle = (field: 'licenseName' | 'licenseNo', next: string | null, existingRaw: string | null | undefined): void => {
    if (!next) return
    const existing = field === 'licenseName' ? normalizeLicenseName(existingRaw) : normalizeLicenseNo(existingRaw)
    if (!existing) { write[field] = next; return }
    if (existing.toLowerCase() === next.toLowerCase()) return
    conflicts.push({ field, existing, fetched: next })
  }
  settle('licenseName', name, store?.licenseName)
  settle('licenseNo', no, store?.licenseNo)

  const action: LicenseWriteDecision['action'] = Object.keys(write).length
    ? 'fill'
    : conflicts.length ? 'conflict' : (rejected.length || fetchedNothing) ? 'nothing' : 'same'
  return { action, write, conflicts, rejected, fetchedNothing }
}
