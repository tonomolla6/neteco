import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  driverManifestSchema,
  type DeliveryEventInput,
  type DeliveryEventResult,
  type DriverManifest
} from '~~/shared/delivery-driver-app'
import {
  applyEventToManifest,
  applySyncResults,
  emptyQueue,
  enqueueEvent,
  parseManifestCache,
  parseQueueSnapshot,
  serializeQueue,
  takeBatch,
  type OfflineQueueState
} from '~~/shared/delivery-offline-queue'

const QUEUE_KEY = 'neteco.delivery.queue.v1'
const MANIFEST_KEY = 'neteco.delivery.manifest.v1'
const QUEUE_TTL_MS = 72 * 3600 * 1000
const MANIFEST_TTL_MS = 12 * 3600 * 1000

const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
function write(key: string, value: string): boolean {
  try {
    storage()?.setItem(key, value)
    return storage() !== null
  } catch {
    return false
  }
}

function classify(error: unknown): { kind: 'auth' | 'network' | 'server'; status: number | null; code: string | null } {
  const e = error as {
    response?: { status?: number }
    status?: number
    statusCode?: number
    data?: { error?: { code?: string } }
  }
  const status = e?.response?.status ?? e?.statusCode ?? e?.status ?? null
  const code = e?.data?.error?.code ?? null
  if (status === 401 || status === 403) return { kind: 'auth', status, code }
  if (status === null) return { kind: 'network', status, code }
  return { kind: 'server', status, code }
}

export function newCommandId(): string {
  const bytes =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  return `cmd-${bytes.replaceAll('-', '').slice(0, 36)}`
}

export function useDeliveryDriverApp() {
  const requestFetch = useRequestFetch()
  const manifest = ref<DriverManifest | null>(null)
  const loading = ref(true)
  const syncing = ref(false)
  const offline = ref(false)
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)
  const rejected = ref<Array<{ commandId: string; code: string }>>([])
  const queue = ref<OfflineQueueState>(emptyQueue())
  const fromCache = ref(false)

  const pending = computed(() => queue.value.events.length)

  function persistQueue(): boolean {
    return write(QUEUE_KEY, serializeQueue(queue.value))
  }
  function persistManifest() {
    if (manifest.value) write(MANIFEST_KEY, JSON.stringify({ savedAt: isoNow(), manifest: manifest.value }))
  }
  /** The server does not know queued events yet, so fold them over whatever snapshot we hold. */
  function project(base: DriverManifest): DriverManifest {
    return queue.value.events.reduce((m, item) => applyEventToManifest(m, item.payload), base)
  }

  async function load() {
    loading.value = manifest.value === null
    error.value = null
    try {
      const response = await requestFetch('/api/delivery/manifest', { cache: 'no-store' })
      const parsed = driverManifestSchema.safeParse(response)
      if (!parsed.success) throw Object.assign(new Error('bad manifest'), { response: { status: 502 } })
      manifest.value = project(parsed.data)
      fromCache.value = false
      offline.value = false
      persistManifest()
    } catch (caught) {
      const failure = classify(caught)
      if (failure.kind === 'auth') {
        manifest.value = null
        error.value =
          failure.status === 401
            ? 'Tu sesión ha caducado. Inicia sesión de nuevo; los eventos pendientes se conservan en este dispositivo.'
            : 'No tienes acceso al reparto con esta cuenta.'
      } else {
        const cached = parseManifestCache(readJson(MANIFEST_KEY), isoNow(), MANIFEST_TTL_MS)
        if (cached) {
          manifest.value = project(cached)
          fromCache.value = true
          offline.value = failure.kind === 'network'
        } else {
          manifest.value = null
          error.value =
            failure.kind === 'network'
              ? 'Sin conexión y sin datos guardados de hoy. Conéctate para cargar tu reparto.'
              : 'No se ha podido cargar tu reparto. Inténtalo de nuevo.'
        }
      }
    } finally {
      loading.value = false
    }
  }

  async function sync() {
    if (syncing.value || queue.value.events.length === 0) return
    syncing.value = true
    let failed = false
    try {
      while (queue.value.events.length > 0) {
        const events = takeBatch(queue.value, { maxEvents: 50, maxBytes: 450_000 })
        let results: DeliveryEventResult[]
        try {
          const response = (await requestFetch('/api/delivery/sync', { method: 'POST', body: { events } })) as {
            results?: DeliveryEventResult[]
          }
          results = response.results ?? []
        } catch (caught) {
          failed = true
          const failure = classify(caught)
          if (failure.kind === 'network') offline.value = true
          else if (failure.kind === 'auth')
            error.value =
              'Tu sesión ha caducado o no tienes acceso. Los eventos siguen guardados y se enviarán al volver a entrar.'
          else error.value = 'El servidor no pudo procesar la sincronización. Se reintentará.'
          break
        }
        const applied = applySyncResults(queue.value, results)
        queue.value = applied.state
        persistQueue()
        rejected.value = [...rejected.value, ...applied.rejected]
        if (results.length === 0 || results.some((r) => r.outcome === 'retry')) {
          failed = true
          break
        }
      }
    } finally {
      syncing.value = false
    }
    if (!failed) {
      offline.value = false
      error.value = null
      await load()
    }
  }

  async function submit(event: DeliveryEventInput): Promise<boolean> {
    const result = enqueueEvent(queue.value, event, isoNow())
    if (!result.accepted) {
      notice.value =
        result.reason === 'queue_full'
          ? 'La cola sin conexión está llena. Sincroniza antes de registrar más eventos.'
          : 'Este evento ya estaba registrado.'
      return false
    }
    const previous = queue.value
    queue.value = result.state
    if (!persistQueue()) {
      queue.value = previous
      notice.value = 'No hay espacio en el dispositivo para guardar este evento sin conexión.'
      return false
    }
    notice.value = null
    if (manifest.value) {
      manifest.value = applyEventToManifest(manifest.value, event)
      persistManifest()
    }
    await sync()
    return true
  }

  function clearLocalData() {
    try {
      const store = storage()
      if (store) for (const key of [QUEUE_KEY, MANIFEST_KEY]) store.removeItem(key)
    } catch {
      /* storage unavailable: nothing persisted */
    }
    queue.value = emptyQueue()
    manifest.value = null
    rejected.value = []
    notice.value = 'Datos locales borrados de este dispositivo.'
  }

  const onOnline = () => {
    offline.value = false
    void sync()
  }
  const onOffline = () => {
    offline.value = true
  }

  onMounted(() => {
    queue.value = parseQueueSnapshot(readJson(QUEUE_KEY), isoNow(), QUEUE_TTL_MS)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    void load().then(() => (navigator.onLine ? sync() : undefined))
    if ('serviceWorker' in navigator)
      navigator.serviceWorker.register('/reparto-sw.js', { scope: '/reparto' }).catch(() => undefined)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  })

  return {
    manifest,
    loading,
    syncing,
    offline,
    error,
    notice,
    rejected,
    pending,
    fromCache,
    load,
    sync,
    submit,
    clearLocalData
  }
}
