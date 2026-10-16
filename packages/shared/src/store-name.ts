/**
 * 「从店铺页面读出真实店铺名」的判据（2026-10-16 用户提出）。
 *
 * 背景：店铺列表里的名字是建店时手输的，现场常见「11121」「1111」这种编号；平台后台页面上
 * 其实写着真名（例如微信小店的 `[class*=shop-info-popover]` 里就是「柚子货货」）。
 *
 * 分工：**主进程负责"把页面上的候选取出来"**（每个平台的 DOM 结构不一样，见
 * apps/desktop/src/main/browser/store-name-reader.ts），**本文件负责"哪个候选能当店名"**——
 * 判据集中在这里，才能用真值表钉死，而不是散在几处各写一遍。
 *
 * 三条硬约束（都是现场踩出来的）：
 *   ① 登录页/注册页**没有**店名，不能把「扫码登录」「登录即代表同意」当店名 → isLoginLikePage；
 *   ② 页面元素文本常是「店名+副标题+退出登录」粘在一起 → 先按行/分隔符切，再逐条剔噪；
 *   ③ 读到的名字只是**建议**：界面拿它预填重命名对话框，由人确认后才落库，绝不静默改名。
 */

/** 店名长度上限（与 stores.name 的表单校验保持一致，避免读出来却存不进去） */
export const STORE_NAME_MAX_LENGTH = 40

/** 页面给出的原始候选：文本 + 来源（元素类名/标题），来源只用于诊断与单测断言 */
export interface StoreNameCandidate {
  text: string
  source: string
}

/** 页面性质粗判：登录页读不到店名，要如实告诉用户"先登录"而不是报"读不到" */
export type StorePageKind = 'backend' | 'login'

/** 出现任何一个就丢弃该候选——这些都是界面词/平台产品词，不是店名 */
const STORE_NAME_NOISE_WORDS = [
  '登录', '注册', '扫码', '密码', '验证码', '手机号', '账号', '客服', '消息', '通知',
  '设置', '帮助', '协议', '隐私', '退出', '首页', '工作台', '商家后台', '管理中心',
  '店铺管理', '加载中', '暂无', '新标签页', '空白页', '安全', '风险', '重置', '忘记',
  '免费开店', '立即开店', '免费注册', '侧边栏', '扫一扫',
  // 平台自家的产品/频道名：实测顶栏兜底会把「巨量千川」当成店名（2026-10-16 真机踩到），
  // 读到**错**的名字比读不到更糟——用户会照着改错。
  // 只收"整词就肯定是平台产品"的（不收「千川」「罗盘」这类短词，免得误伤「千川优选」这种真店名）。
  '巨量千川', '巨量引擎', '电商罗盘', '飞鸽', '快语', '服务市场',
  '应用市场', '开放平台', '学习中心', '数据中心', '营销中心', '消息中心', '帮助中心',
  '体验分', '商品管理', '订单管理'
]

/** 平台给标题加的前后缀（去掉之后剩下的才是店名；比较前会把 " - " 这类分隔符压成 "-"） */
const STORE_NAME_TITLE_AFFIXES = [
  '-抖店后台-抖音电商后台', '- 抖店后台', '-抖音电商后台', '抖店后台',
  '-快手小店', '_快手小店', '-微信小店', '-拼多多商家后台', '拼多多商家后台',
  '-商家后台', '-商家中心', '-管理后台', '- 拼多多', '- 抖店'
]

/**
 * 平台自己的名字（不是店名）：整串**等于**它们就丢掉。
 * 只做"整串相等"判断，不做前缀剥离——否则「拼多多优选」会被剥成「优选」，
 * 把真店名改坏；而「快手小店」这种整串平台名又必须拒掉。
 */
const PLATFORM_GENERIC_NAMES = ['抖店', '抖店后台', '拼多多', '拼多多商家后台', '微信小店', '快手小店', '抖音电商', '商家后台', '商家中心']

/** 分隔符压平：'柚子货货 - 微信小店' → '柚子货货-微信小店'，否则带空格的后缀剥不掉 */
function compactSeparators(text: string): string {
  return text.replace(/\s*[-–—_|·]\s*/g, '-')
}

/** 登录页特征：URL 路径，或页面上典型的登录文案 */
const LOGIN_URL_PATTERN = /\/login|login\.|\/signin|passport|account\/login/i
const LOGIN_TEXT_MARKERS = ['扫码登录', '密码登录', '短信登录', '登录即代表同意', '立即登录', '免费注册开店', '请登录']

export function isLoginLikePage(input: { url?: string; text?: string }): boolean {
  const url = String(input.url || '')
  if (LOGIN_URL_PATTERN.test(url)) return true
  const text = String(input.text || '')
  return LOGIN_TEXT_MARKERS.some(marker => text.includes(marker))
}

/** 去掉"店铺名称："这类前缀、平台标题前后缀与首尾分隔符 */
export function stripStoreNameNoise(raw: string): string {
  let text = compactSeparators(String(raw || '').replace(/\s+/g, ' ').replace(/[\u3000]/g, ' ').trim())
  text = text.replace(/^(店铺名称|店铺名|商家名称|商家名|店铺)[：:]\s*/, '')
  let changed = true
  while (changed) {
    changed = false
    for (const affix of STORE_NAME_TITLE_AFFIXES) {
      const compactAffix = compactSeparators(affix)
      if (text.endsWith(compactAffix)) { text = text.slice(0, -compactAffix.length).trim(); changed = true }
      if (text.startsWith(compactAffix)) { text = text.slice(compactAffix.length).trim(); changed = true }
    }
  }
  return text.replace(/^[-|_·\s]+/, '').replace(/[-|_·\s]+$/, '').trim()
}

/** 这个候选配不配当店名（空、太长、含界面词、纯符号、纯编号都不配） */
export function isStoreNameJunk(name: string): boolean {
  const text = String(name || '').trim()
  if (text.length < 2 || text.length > STORE_NAME_MAX_LENGTH) return true
  if (STORE_NAME_NOISE_WORDS.some(word => text.includes(word))) return true
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(text)) return true
  // 纯数字/编号（「11121」这种就是用户想甩掉的占位名，不能反过来被当成"读到的真名"）
  if (/^[\d\s\-_.]+$/.test(text)) return true
  // 整串就是平台名（"快手小店""微信小店"）→ 那是平台，不是这家店
  if (PLATFORM_GENERIC_NAMES.includes(text.replace(/[-_\s]+$/, ''))) return true
  return false
}

/** 取第一个能当店名的候选；候选顺序由主进程按"可靠性从高到低"给出 */
export function pickStoreName(input: { candidates: StoreNameCandidate[] }): { name: string; source: string } | null {
  for (const candidate of input.candidates || []) {
    const raw = String(candidate?.text || '')
    const name = stripStoreNameNoise(raw)
    if (isStoreNameJunk(name)) continue
    // 页面标题单独收紧：平台标题多半是**页面名**而不是店名（实测抖店某页标题就是「活动广场」，
    // 直接当店名读出来是错的）。只有"店名 - 平台名"这种**剥掉平台后缀还剩下东西**的标题才算证据。
    if (candidate.source === 'title' && compactSeparators(raw).replace(/\s+/g, ' ').trim() === name) continue
    return { name, source: candidate.source }
  }
  return null
}

/** 名字像占位符吗（纯数字/出生名）：用于"要不要提示用户去读真名"，不用于自动改名 */
export function looksLikePlaceholderStoreName(name: string): boolean {
  const text = String(name || '').trim()
  if (text.length < 2) return true
  if (/^[\d\s\-_.]+$/.test(text)) return true
  return /^(店铺|store|shop|测试|test)[\s\d\-_.]*$/i.test(text)
}
