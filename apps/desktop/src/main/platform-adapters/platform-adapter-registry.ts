import { findPlatform, PLATFORM_CATALOG } from '@shared/constants/platforms'
import type { PlatformAdapter } from './platform-adapter'
import { PddAdapter } from './pdd-adapter'
import { DouDianAdapter } from './dou-dian-adapter'
import { KuaishouAdapter } from './kuaishou-adapter'
import { WeChatShopAdapter } from './wechat-shop-adapter'

export class PlatformAdapterRegistryError extends Error {
  readonly code: 'UNSUPPORTED_PLATFORM' | 'ADAPTER_NOT_FOUND'

  constructor(code: 'UNSUPPORTED_PLATFORM' | 'ADAPTER_NOT_FOUND', platform: string) {
    super(code === 'UNSUPPORTED_PLATFORM'
      ? `UNSUPPORTED_PLATFORM: ${platform}`
      : `ADAPTER_NOT_FOUND: ${platform}`)
    this.name = 'PlatformAdapterRegistryError'
    this.code = code
  }
}

/** 只按现有 stores.platform 原值匹配，不做别名、模糊匹配或默认回退。 */
export class PlatformAdapterRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>()

  constructor(adapters: readonly PlatformAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: PlatformAdapter): void {
    const key = adapter.platform
    if (!key || !adapter.supports(key)) throw new Error('ADAPTER_NOT_FOUND: invalid adapter registration')
    if (this.adapters.has(key)) throw new Error(`ADAPTER_ALREADY_REGISTERED: ${key}`)
    this.adapters.set(key, adapter)
  }

  getAdapter(platform: string): PlatformAdapter {
    const adapter = this.adapters.get(platform)
    if (adapter) return adapter
    const knownPlatform = PLATFORM_CATALOG.some(item => item.name === platform)
    throw new PlatformAdapterRegistryError(knownPlatform ? 'ADAPTER_NOT_FOUND' : 'UNSUPPORTED_PLATFORM', platform)
  }

  resolveAdapter(platform: string): PlatformAdapter | null {
    return this.adapters.get(platform) || null
  }

  supports(platform: string): boolean {
    const adapter = this.adapters.get(platform)
    return !!adapter?.supports(platform)
  }

  listPlatforms(): string[] {
    return [...this.adapters.keys()]
  }
}

function requiredPlatform(name: string) {
  const definition = findPlatform(name)
  if (!definition) throw new Error(`PLATFORM_CATALOG_ENTRY_MISSING: ${name}`)
  return definition
}

/** 默认 Registry 的标识直接取现有平台目录，不另建平台 ID/枚举。 */
export function createDefaultPlatformAdapterRegistry(): PlatformAdapterRegistry {
  return new PlatformAdapterRegistry([
    new PddAdapter(requiredPlatform('拼多多')),
    new DouDianAdapter(requiredPlatform('抖店')),
    new KuaishouAdapter(requiredPlatform('快手小店')),
    new WeChatShopAdapter(requiredPlatform('微信小店'))
  ])
}

export const platformAdapterRegistry = createDefaultPlatformAdapterRegistry()

