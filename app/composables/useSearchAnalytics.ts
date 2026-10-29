import {
  redactSearchPii,
  sanitizeSearchQuery,
  type SearchDevice,
  type SearchSegment
} from '../../workers/analytics/search-analytics'

export function detectCoarseDevice(): SearchDevice {
  if (typeof window === 'undefined') return 'unknown'
  const width = window.innerWidth
  if (width < 640) return 'mobile'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

export function useSearchAnalytics() {
  const { preferences } = useConsent()
  const { loggedIn, user } = useUserSession()

  function currentSegment(): SearchSegment {
    if (!loggedIn.value || !user.value) return 'anonymous'
    const role = (user.value as { role?: string; segment?: string })?.role ?? ''
    const isB2b =
      role.includes('b2b') || role.includes('professional') || (user.value as { isCompany?: boolean })?.isCompany
    return isB2b ? 'professional' : 'customer'
  }

  async function postEvent(body: Record<string, unknown>) {
    if (!import.meta.client || preferences.value?.analytics !== true) return
    try {
      await $fetch('/api/analytics/events', {
        method: 'POST',
        body,
        retry: 0,
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer'
      })
    } catch {
      // Measurement failure must never break storefront
    }
  }

  async function trackSearch(
    query: string,
    resultCount: number,
    options?: { device?: SearchDevice; segment?: SearchSegment }
  ) {
    if (!import.meta.client || preferences.value?.analytics !== true || !query.trim()) return
    const sanitized = sanitizeSearchQuery(query)
    if (!sanitized) return

    const device = options?.device ?? detectCoarseDevice()
    const segment = options?.segment ?? currentSegment()

    await postEvent({
      name: 'search_performed',
      query: sanitized,
      resultCount: Math.max(0, Math.floor(resultCount)),
      device,
      segment,
      occurredAt: new Date().toISOString()
    })
  }

  async function trackSearchClick(
    targetId: string,
    rank: number,
    options?: { query?: string; device?: SearchDevice; segment?: SearchSegment }
  ) {
    if (!import.meta.client || preferences.value?.analytics !== true || !targetId) return

    const device = options?.device ?? detectCoarseDevice()
    const segment = options?.segment ?? currentSegment()

    const body: Record<string, unknown> = {
      name: 'search_result_clicked',
      targetId,
      rank: Math.max(1, Math.floor(rank)),
      device,
      segment,
      occurredAt: new Date().toISOString()
    }

    if (options?.query) {
      body.query = sanitizeSearchQuery(options.query)
    }

    await postEvent(body)
  }

  async function trackSearchAddToCart(
    targetId: string,
    quantity = 1,
    options?: { query?: string; device?: SearchDevice; segment?: SearchSegment }
  ) {
    if (!import.meta.client || preferences.value?.analytics !== true || !targetId) return

    const device = options?.device ?? detectCoarseDevice()
    const segment = options?.segment ?? currentSegment()

    const body: Record<string, unknown> = {
      name: 'add_to_cart',
      targetId,
      quantity: Math.max(1, Math.floor(quantity)),
      device,
      segment,
      occurredAt: new Date().toISOString()
    }

    if (options?.query) {
      body.query = sanitizeSearchQuery(options.query)
    }

    await postEvent(body)
  }

  return {
    trackSearch,
    trackSearchClick,
    trackSearchAddToCart,
    redactSearchPii,
    sanitizeSearchQuery
  }
}
