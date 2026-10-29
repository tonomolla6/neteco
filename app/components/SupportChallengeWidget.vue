<script lang="ts">
import { supportChallengeConfigurationSchema } from '~~/shared/support-operations'
interface SupportTurnstileOptions {
  sitekey: string
  action: 'neteco_support'
  theme: 'auto'
  size: 'flexible'
  language: 'es'
  tabindex: 0
  'response-field': false
  retry: 'never'
  'refresh-expired': 'manual'
  'refresh-timeout': 'manual'
  callback: (token: unknown) => void
  'error-callback': () => void
  'expired-callback': () => void
  'timeout-callback': () => void
  'unsupported-callback': () => void
}
interface SupportTurnstileApi {
  render: (container: HTMLElement, options: SupportTurnstileOptions) => string | undefined
  ready: (callback: () => void) => void
  reset: (id: string) => void
  remove: (id: string) => void
}
const SUPPORT_TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const scriptLoads = new WeakMap<
  Document,
  { script: HTMLScriptElement; promise: Promise<SupportTurnstileApi>; failed: boolean }
>()
function turnstileApi(value: unknown): value is SupportTurnstileApi {
  return (
    value !== null &&
    typeof value === 'object' &&
    ['render', 'ready', 'reset', 'remove'].every((key) => typeof Reflect.get(value, key) === 'function')
  )
}
function browserApi() {
  const candidate = Reflect.get(window, 'turnstile')
  return turnstileApi(candidate) ? candidate : null
}
/** One official script per document; callbacks contain no tokens or identities.
 * Failed loading can only be retried by an explicit visitor action. */
function loadTurnstile(): Promise<SupportTurnstileApi> {
  const api = browserApi()
  if (api) return Promise.resolve(api)
  const previous = scriptLoads.get(document)
  if (previous && !previous.failed && previous.script.isConnected) return previous.promise
  if (previous?.failed && previous.script.dataset.netecoSupportTurnstile === 'owned') previous.script.remove()
  const found = [...document.querySelectorAll('script[src]')].find(
    (script) => script instanceof HTMLScriptElement && script.src === SUPPORT_TURNSTILE_SCRIPT
  )
  const script = found instanceof HTMLScriptElement ? found : document.createElement('script')
  if (!found) {
    script.src = SUPPORT_TURNSTILE_SCRIPT
    script.async = true
    script.defer = true
    script.dataset.netecoSupportTurnstile = 'owned'
  }
  let failed = false
  const promise = new Promise<SupportTurnstileApi>((resolve, reject) => {
    const cleanup = () => {
      script.removeEventListener('load', loaded)
      script.removeEventListener('error', error)
      window.clearTimeout(timer)
    }
    const loaded = () => {
      const current = browserApi()
      cleanup()
      if (current) resolve(current)
      else {
        failed = true
        const entry = scriptLoads.get(document)
        if (entry) entry.failed = true
        reject(new Error('support_challenge_sdk_unavailable'))
      }
    }
    const error = () => {
      cleanup()
      failed = true
      const entry = scriptLoads.get(document)
      if (entry) entry.failed = true
      reject(new Error('support_challenge_script_unavailable'))
    }
    const timer = window.setTimeout(error, 15000)
    script.addEventListener('load', loaded, { once: true })
    script.addEventListener('error', error, { once: true })
  })
  scriptLoads.set(document, { script, promise, failed })
  if (!found) document.head.appendChild(script)
  return promise
}
</script>
<script setup lang="ts">
const props = defineProps<{ configuration: unknown; runtime: unknown; authorized: boolean }>()
const emit = defineEmits<{ token: [value: string] }>()
const container = ref<HTMLElement | null>(null),
  mounted = ref(false),
  status = ref<'disabled' | 'loading' | 'waiting' | 'obtained' | 'expired' | 'failed'>('disabled')
const configuration = computed(() => {
  const parsed = supportChallengeConfigurationSchema.safeParse(props.configuration)
  return parsed.success ? parsed.data : null
})
const permitted = () =>
  mounted.value && props.runtime === 'cloudflare' && props.authorized === true && configuration.value !== null
let active = true,
  generation = 0,
  api: SupportTurnstileApi | null = null,
  widgetId: string | null = null
function clear() {
  generation++
  emit('token', '')
  if (api && widgetId !== null) {
    try {
      api.remove(widgetId)
    } catch {
      /* Removed widget cannot retain authority. */
    }
  }
  widgetId = null
  api = null
}
function invalid(epoch: number, state: 'failed' | 'expired') {
  if (!active || generation !== epoch || !permitted()) return
  // All callbacks of this attempt are revoked, including a late success.
  generation++
  emit('token', '')
  status.value = state
}
async function start() {
  clear()
  const descriptor = configuration.value
  if (!permitted() || !descriptor) {
    status.value = 'disabled'
    return
  }
  status.value = 'loading'
  const epoch = generation,
    key = descriptor.siteKey
  const current = () => active && generation === epoch && permitted() && configuration.value?.siteKey === key
  try {
    const loaded = await loadTurnstile()
    if (!current()) return
    loaded.ready(() => {
      if (!current() || !container.value) return
      try {
        api = loaded
        status.value = 'waiting'
        const id = loaded.render(container.value, {
          sitekey: key,
          action: 'neteco_support',
          theme: 'auto',
          size: 'flexible',
          language: 'es',
          tabindex: 0,
          'response-field': false,
          retry: 'never',
          'refresh-expired': 'manual',
          'refresh-timeout': 'manual',
          callback(token) {
            if (!current()) return
            if (typeof token !== 'string' || token.length < 1 || token.length > 2048 || /\s/.test(token)) {
              invalid(epoch, 'failed')
              return
            }
            emit('token', token)
            status.value = 'obtained'
          },
          'error-callback': () => invalid(epoch, 'failed'),
          'expired-callback': () => invalid(epoch, 'expired'),
          'timeout-callback': () => invalid(epoch, 'expired'),
          'unsupported-callback': () => invalid(epoch, 'failed')
        })
        if (!current()) {
          if (typeof id === 'string') loaded.remove(id)
          return
        }
        if (typeof id !== 'string' || id.length < 1) {
          invalid(epoch, 'failed')
          return
        }
        widgetId = id
      } catch {
        invalid(epoch, 'failed')
      }
    })
  } catch {
    invalid(epoch, 'failed')
  }
}
function reset() {
  if (!permitted()) return
  // A new widget creates new epoch-bound callbacks. SDK reset would retain the
  // revoked closure and cannot distinguish a late previous success.
  void start()
}
watch(
  () => [mounted.value, props.runtime, props.authorized, configuration.value?.siteKey],
  () => {
    void start()
  },
  { immediate: true, flush: 'post' }
)
onMounted(() => {
  mounted.value = true
})
onBeforeUnmount(() => {
  active = false
  clear()
})
</script>
<template>
  <section aria-label="Verificación antiabuso de soporte" class="space-y-2">
    <p v-if="status === 'disabled'" role="status">
      La verificación antiabuso no está configurada o no se ha confirmado el contexto.
    </p>
    <template v-else>
      <p v-if="status === 'loading'" role="status" aria-live="polite">Cargando la verificación antiabuso…</p>
      <p v-else-if="status === 'waiting'" role="status" aria-live="polite">
        Completa la verificación accesible de Turnstile.
      </p>
      <p v-else-if="status === 'obtained'" role="status" aria-live="polite">
        Respuesta de verificación obtenida. El servidor debe validarla antes de registrar la consulta.
      </p>
      <p v-else-if="status === 'expired'" role="alert">
        La respuesta de verificación ha caducado. Renueva el desafío antes de continuar.
      </p>
      <p v-else role="alert">
        No se ha podido completar la verificación. Comprueba los bloqueadores o la conexión y reintenta manualmente.
      </p>
      <div ref="container" data-testid="support-turnstile-container" class="min-h-16" />
      <button
        v-if="status !== 'loading'"
        type="button"
        data-testid="support-challenge-reset"
        class="rounded border p-2"
        @click="reset"
      >
        Renovar verificación
      </button>
    </template>
    <noscript
      >La verificación requiere JavaScript. No se sustituye por una casilla ni se acredita identidad con este
      desafío.</noscript
    >
  </section>
</template>
