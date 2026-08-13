type AnalyticsEventName =
  | 'page_view'
  | 'catalog_viewed'
  | 'search_completed'
  | 'product_viewed'
  | 'cart_item_added'
  | 'cart_item_removed'
  | 'checkout_started'
  | 'web_vital'

export function useAnalytics() {
  const { preferences } = useConsent()

  async function track(name: AnalyticsEventName, properties: Record<string, string | number | boolean | null>) {
    if (!import.meta.client || !preferences.value?.analytics) return
    const event = {
      eventId: crypto.randomUUID(),
      taxonomyVersion: 'v1' as const,
      name,
      occurredAt: new Date().toISOString(),
      properties
    }
    const dataLayer = (window as typeof window & { dataLayer?: unknown[] }).dataLayer
    if (Array.isArray(dataLayer)) dataLayer.push({ event: name, ...properties })
    await $fetch('/api/analytics/events', { method: 'POST', body: event }).catch(() => undefined)
  }

  return { track }
}
