import { parseChatWidget } from '~~/shared/chat-widget'
import type { ConsentPreferences } from '~/composables/useConsent'

/**
 * Carga el chat externo si está configurado. Fuera del panel de administración. Si el
 * proveedor usa cookies, espera al consentimiento de marketing (también si llega después).
 */
export default defineNuxtPlugin(() => {
  const config = parseChatWidget(useRuntimeConfig().public.commercial)
  if (!config) return
  const route = useRoute()
  const { preferences } = useConsent()
  const tryMount = (consent: { marketing: boolean } | null) => {
    if (route.path.startsWith('/admin')) return
    mountChatWidget(document, config, consent)
  }
  onNuxtReady(() => tryMount(preferences.value))
  window.addEventListener('neteco-consent-changed', (event) =>
    tryMount((event as CustomEvent<ConsentPreferences>).detail)
  )
  useRouter().afterEach(() => tryMount(preferences.value))
})
