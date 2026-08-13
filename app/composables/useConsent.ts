export interface ConsentPreferences {
  version: 'v1'
  necessary: true
  analytics: boolean
  marketing: boolean
  decidedAt: string
}

export function useConsent() {
  const runtime = useRuntimeConfig()
  const cookie = useCookie<ConsentPreferences | null>('neteco-consent-v1', {
    default: () => null,
    maxAge: 180 * 24 * 60 * 60,
    sameSite: 'lax',
    secure: runtime.public.appEnv === 'production'
  })
  const preferences = useState<ConsentPreferences | null>('neteco-consent', () => cookie.value)
  // Public pages are SWR-cached and their serialized state must never override the
  // visitor's current browser decision after a full navigation.
  if (import.meta.client) preferences.value = cookie.value

  function save(value: Pick<ConsentPreferences, 'analytics' | 'marketing'>) {
    const decision: ConsentPreferences = {
      version: 'v1',
      necessary: true,
      analytics: value.analytics,
      marketing: value.marketing,
      decidedAt: new Date().toISOString()
    }
    cookie.value = decision
    preferences.value = decision
    if (!decision.analytics && import.meta.client) {
      void $fetch('/api/analytics/session', { method: 'DELETE' }).catch(() => undefined)
    }
    if (import.meta.client) window.dispatchEvent(new CustomEvent('neteco-consent-changed', { detail: decision }))
  }

  return {
    preferences: readonly(preferences),
    acceptAll: () => save({ analytics: true, marketing: true }),
    rejectOptional: () => save({ analytics: false, marketing: false }),
    save
  }
}
