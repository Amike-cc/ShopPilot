/**
 * 可选功能模块的安装状态（2026-11-09）。
 *
 * 核心功能（店铺/数据/设置/经营总览/应用商城）不在这里；这里只管理「可下载安装 / 卸载」
 * 的内置业务模块。卸载 = 从导航与商城入口隐藏，业务数据保留；重新下载安装即恢复入口。
 * 模块代码随应用打包，所谓"下载"是启用内置副本，不联网——文案必须说清楚，不能假装在线下载。
 */
import { reactive } from 'vue'

export type OptionalModuleKey = 'invoices' | 'tax' | 'ai'

export const OPTIONAL_MODULE_KEYS: OptionalModuleKey[] = ['invoices', 'tax', 'ai']

/** 走通用 settings 通道的 ui.* 白名单键，按机器持久化 */
const SETTING_KEY = 'ui.apps.installedModules'

/** 缺省全部已安装：老用户升级后入口不消失；只有显式写过 [] 才会全部隐藏 */
export const installedModules = reactive<Record<OptionalModuleKey, boolean>>({
  invoices: true,
  tax: true,
  ai: true
})

let loaded = false
let loading: Promise<void> | null = null

export function isModuleInstalled(key: string): boolean {
  return installedModules[key as OptionalModuleKey] !== false
}

/** 首次进入工作台/商城时读一次；读不到按全部已安装处理，绝不因为读失败藏入口 */
export async function ensureAppModulesLoaded(): Promise<void> {
  if (loaded) return
  if (loading) return loading
  loading = (async () => {
    try {
      const result = await window.shopilot.settings.get(SETTING_KEY)
      const list = result.ok ? result.data?.value : null
      if (Array.isArray(list)) {
        for (const key of OPTIONAL_MODULE_KEYS) installedModules[key] = list.includes(key)
      }
    } catch {
      /* 读失败保持默认（全部已安装） */
    } finally {
      loaded = true
      loading = null
    }
  })()
  return loading
}

export async function setModuleInstalled(key: OptionalModuleKey, next: boolean): Promise<{ ok: boolean; error?: string }> {
  const previous = installedModules[key]
  installedModules[key] = next
  try {
    const list = OPTIONAL_MODULE_KEYS.filter((item) => installedModules[item])
    const result = await window.shopilot.settings.set(SETTING_KEY, list)
    if (!result.ok) {
      installedModules[key] = previous
      return { ok: false, error: String((result.error as { message?: string } | undefined)?.message || '保存安装状态失败') }
    }
    return { ok: true }
  } catch (e) {
    installedModules[key] = previous
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}
