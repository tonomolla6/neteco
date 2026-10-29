import { computed, ref, shallowRef, onBeforeUnmount } from 'vue'
export function useSupportRead<T>(options: {
  authorize: () => boolean
  owner: () => string | null
  request: (endpoint: string, query: Record<string, string | number>) => Promise<unknown>
  endpoint: () => string
  query: () => Record<string, string | number>
  decode: (raw: unknown) => T | null
}) {
  const snapshot = shallowRef<T | null>(null),
    loading = ref(false),
    failed = ref(false)
  let active = true,
    generation = 0,
    flight: { owner: string; generation: number; promise: Promise<T> } | null = null
  function reset() {
    generation++
    snapshot.value = null
    loading.value = false
    failed.value = false
    flight = null
  }
  function reload(): Promise<T> {
    const owner = options.owner(),
      epoch = generation,
      endpoint = options.endpoint()
    const current = () =>
      active &&
      generation === epoch &&
      options.owner() === owner &&
      options.authorize() &&
      options.endpoint() === endpoint
    if (!owner || !options.authorize()) {
      snapshot.value = null
      return Promise.reject(new Error('support_access_unconfirmed'))
    }
    if (flight?.owner === owner && flight.generation === epoch) return flight.promise
    snapshot.value = null
    loading.value = true
    failed.value = false
    const query = { ...options.query() }
    const promise = Promise.resolve().then(async () => {
      try {
        if (!current()) throw new Error('support_access_unconfirmed')
        const raw = await options.request(endpoint, query)
        if (!current()) throw new Error('support_access_unconfirmed')
        const decoded = options.decode(raw)
        if (decoded === null || !current()) throw new Error('support_read_unconfirmed')
        snapshot.value = decoded
        return decoded
      } catch (error) {
        if (current()) {
          snapshot.value = null
          failed.value = true
        }
        throw error
      } finally {
        if (active && generation === epoch && options.owner() === owner) {
          loading.value = false
          flight = null
        }
      }
    })
    flight = { owner, generation: epoch, promise }
    return promise
  }
  const refresh = () => {
    if (options.authorize()) void reload().catch(() => undefined)
  }
  const visible = computed(() => (options.authorize() ? snapshot.value : null))
  onBeforeUnmount(() => {
    active = false
    reset()
  })
  return { snapshot: visible, loading, failed, reload, refresh, reset }
}
