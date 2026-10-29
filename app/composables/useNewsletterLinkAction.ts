const NEWSLETTER_ENDPOINTS = {
  confirm: '/api/newsletter/confirm',
  unsubscribe: '/api/newsletter/unsubscribe'
} as const

/** Both runtimes share this opaque-token contract. D1 intentionally processes
 * invalid/expired/used tokens indistinguishably; a receipt is not proof of consent. */
export function useNewsletterLinkAction(action: keyof typeof NEWSLETTER_ENDPOINTS) {
  const route = useRoute()
  const candidate = route.query.token
  const token = typeof candidate === 'string' && candidate.length >= 32 && candidate.length <= 256 ? candidate : null
  const endpoint = Object.hasOwn(NEWSLETTER_ENDPOINTS, action) ? NEWSLETTER_ENDPOINTS[action] : null
  let fatal = token === null || endpoint === null
  let pending = false
  let completed = false
  let generation = 0
  const status = ref<'ready' | 'loading' | 'success' | 'error' | 'fatal'>(fatal ? 'fatal' : 'ready')
  const message = ref(fatal ? 'El enlace está incompleto o no es válido. Abre el enlace del último mensaje.' : '')
  const runtime = useRuntimeConfig()
  const canOpenPreferences = computed(
    () =>
      action === 'confirm' &&
      status.value === 'success' &&
      runtime.public.serverRuntime === 'cloudflare' &&
      typeof token === 'string' &&
      /^n1\.[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(token)
  )

  onMounted(() => {
    if (typeof window === 'undefined') return
    // Keep the token only in this closure, never in the rendered UI or a log.
    // Preserve the existing clean-path behavior, including repeated/invalid query tokens.
    if (Object.hasOwn(route.query, 'token') || new URL(window.location.href).searchParams.has('token')) {
      try {
        window.history.replaceState(window.history.state, '', window.location.pathname)
      } catch {
        fatal = true
        status.value = 'fatal'
        message.value = 'No se ha podido preparar este enlace. Abre el enlace del último mensaje.'
      }
    }
  })
  onBeforeUnmount(() => {
    fatal = true
    ++generation
  })

  async function submit() {
    if (
      !token ||
      !endpoint ||
      fatal ||
      pending ||
      completed ||
      status.value === 'loading' ||
      status.value === 'success' ||
      status.value === 'fatal'
    )
      return
    pending = true
    status.value = 'loading'
    message.value = ''
    const request = ++generation
    try {
      const result = await $fetch<unknown>(endpoint, { method: 'POST', body: { token } })
      if (request !== generation) return
      if (
        result === null ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).length !== 1 ||
        Object.getOwnPropertyDescriptor(result, 'ok')?.value !== true
      ) {
        status.value = 'error'
        message.value = 'No hemos podido confirmar la respuesta. Puedes volver a intentarlo.'
        return
      }
      completed = true
      status.value = 'success'
    } catch (cause) {
      if (request !== generation) return
      const error = cause as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } } | null
      const code = error?.statusCode ?? error?.status ?? error?.response?.status
      if (typeof code === 'number' && code >= 400 && code < 500 && code !== 429) {
        fatal = true
        status.value = 'fatal'
        message.value = 'No hemos podido procesar este enlace. Usa el enlace del último mensaje o contacta con soporte.'
      } else {
        status.value = 'error'
        message.value =
          code === 429
            ? 'Hay demasiadas solicitudes. Espera un momento y vuelve a intentarlo.'
            : 'No hemos podido procesar la solicitud. Puedes volver a intentarlo sin recargar la página.'
      }
    } finally {
      if (request === generation) pending = false
    }
  }

  async function openPreferences() {
    if (!canOpenPreferences.value || fatal || !completed || !token) return
    // Client navigation only after an explicit action: no token in SSR, href,
    // rendered text, analytics or a fabricated claim of confirmed consent.
    await navigateTo({ path: '/newsletter/preferencias', query: { confirm: token } })
  }

  return { status, message, submit, canOpenPreferences, openPreferences }
}
