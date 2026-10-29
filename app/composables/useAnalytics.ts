import { dispatchClientAnalytics, type ClientAnalyticsEventName } from '~~/shared/analytics-client'
import { isPrivateAnalyticsRoute } from '~~/shared/analytics-privacy'

export function useAnalytics() {
  const { preferences } = useConsent()
  const route = useRoute()

  async function track(name: ClientAnalyticsEventName, properties: Record<string, string | number | boolean | null>) {
    if (!import.meta.client || preferences.value?.analytics !== true) return
    if (isPrivateAnalyticsRoute(route.path, route.query)) return
    const event = {
      eventId: randomId(),
      taxonomyVersion: 'v1' as const,
      name,
      occurredAt: new Date().toISOString(),
      properties
    }
    const dataLayer = (window as typeof window & { dataLayer?: unknown[] }).dataLayer
    let submitted = false
    await dispatchClientAnalytics(
      { consent: preferences.value.analytics, path: route.path, query: route.query, event },
      (body) => {
        submitted = true
        return $fetch('/api/analytics/events', {
          method: 'POST',
          body,
          retry: 0,
          credentials: 'same-origin',
          referrerPolicy: 'no-referrer'
        })
      },
      dataLayer
    )
    // CMP already clears immediately. A previously accepted POST may settle
    // later with Set-Cookie, so clear once more after that request completes.
    // This is an in-page defense, not a guarantee across unload/navigation.
    if (submitted && preferences.value?.analytics !== true) {
      await $fetch('/api/analytics/session', {
        method: 'DELETE',
        retry: 0,
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer'
      }).catch(() => undefined)
    }
  }

  return { track }
}
