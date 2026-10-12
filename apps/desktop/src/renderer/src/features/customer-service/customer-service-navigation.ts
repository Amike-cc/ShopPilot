import { isAllowedCustomerServiceUrl } from '@shared/contracts/customer-service'

/** Keep only a route belonging to this store's platform when its WebView is remounted. */
export function resolveCustomerServiceNavigationUrl(
  platform: string,
  preparedUrl: string,
  rememberedUrl: string,
  hasNavigated: boolean
): string {
  if (isAllowedCustomerServiceUrl(platform, preparedUrl)) {
    if (hasNavigated && isAllowedCustomerServiceUrl(platform, rememberedUrl)) return rememberedUrl
    return preparedUrl
  }
  return ''
}
