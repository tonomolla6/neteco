import {
  adminCapabilitiesSchema,
  adminNavigationGroups,
  canNavigateAdmin,
  type AdminCapabilities
} from '~~/shared/admin-navigation'

// Request-scoped on SSR, ephemeral in the browser; promises are never serialized
// into payload state. Only identical concurrent reads share a request.
const pendingReads = new WeakMap<
  object,
  Map<string, { generation: number; promise: Promise<AdminCapabilities | null> }>
>()

/** Ephemeral self-read, bound to the current identity, session and route. Never
 * used as server authorization or persisted to localStorage/cookies. */
export function useAdminNavigation() {
  const { loggedIn, user, session } = useUserSession()
  const runtime = useRuntimeConfig(),
    router = useRouter(),
    request = useRequestFetch()
  const app = useNuxtApp()
  let pending = pendingReads.get(app)
  if (!pending) {
    pending = new Map()
    pendingReads.set(app, pending)
  }
  const requests = pending
  const cloudflare = computed(() => runtime.public.serverRuntime === 'cloudflare')
  const identityKey = computed(() =>
    JSON.stringify([
      loggedIn.value,
      user.value?.id,
      session.value?.sessionId,
      session.value?.sessionVersion,
      user.value?.emailVerified,
      user.value?.mfaVerified
    ])
  )
  const keyFor = (path: string) => identityKey.value + '|' + path
  // Nuxt's useRoute waits for page:finish. Using that deferred route here
  // hides the layout slot after middleware authorizes the next page, so the
  // page cannot mount and finish. Authorization follows the committed router
  // route while retaining the same identity/session binding.
  const key = computed(() => keyFor(router.currentRoute.value.fullPath))
  const state = useState<{
    key: string
    generation: number
    status: 'idle' | 'loading' | 'ready' | 'error' | 'unauthenticated'
    capabilities: AdminCapabilities | null
  }>('admin-navigation', () => ({ key: '', generation: 0, status: 'idle', capabilities: null }))
  const usable = computed(() => state.value.key === key.value)
  const capabilities = computed(() => (usable.value ? state.value.capabilities : null))
  const status = computed(() => (usable.value ? state.value.status : 'idle'))
  async function read(path: string): Promise<AdminCapabilities | null> {
    const requestKey = keyFor(path),
      generation = state.value.generation + 1,
      owner = identityKey.value
    state.value = { key: requestKey, generation, status: 'loading', capabilities: null }
    if (!cloudflare.value || !loggedIn.value) {
      state.value = { key: requestKey, generation, status: 'idle', capabilities: null }
      return null
    }
    try {
      const result = adminCapabilitiesSchema.parse(await request('/api/admin/capabilities', { cache: 'no-store' }))
      if (
        result.identityId !== user.value?.id ||
        result.sessionId !== session.value?.sessionId ||
        result.sessionVersion !== session.value?.sessionVersion
      )
        throw new Error('stale_capability_session')
      if (state.value.generation !== generation || identityKey.value !== owner) return null
      state.value = { key: requestKey, generation, status: 'ready', capabilities: result }
      return result
    } catch (error: unknown) {
      if (state.value.generation === generation && identityKey.value === owner) {
        const failure =
          error && typeof error === 'object'
            ? (error as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } })
            : null
        const expired = failure?.statusCode === 401 || failure?.status === 401 || failure?.response?.status === 401
        state.value = { key: requestKey, generation, status: expired ? 'unauthenticated' : 'error', capabilities: null }
      }
      return null
    }
  }
  function refresh(path = router.currentRoute.value.fullPath): Promise<AdminCapabilities | null> {
    const requestKey = keyFor(path),
      existing = requests.get(requestKey)
    if (existing && state.value.key === requestKey && existing.generation === state.value.generation)
      return existing.promise
    const promise = read(path)
    requests.set(requestKey, { generation: state.value.generation, promise })
    void promise.finally(() => {
      if (requests.get(requestKey)?.promise === promise) requests.delete(requestKey)
    })
    return promise
  }
  watch(
    key,
    () => {
      // SSR can serialize "loading", but never its request-scoped promise.
      // Resume only an orphaned read; another live client consumer still owns
      // the matching promise and must keep sharing that same request.
      if (
        state.value.key !== key.value ||
        state.value.status === 'idle' ||
        (state.value.status === 'loading' && !requests.has(key.value))
      )
        void refresh()
    },
    { immediate: true, flush: 'sync' }
  )
  const groups = computed(() => adminNavigationGroups(capabilities.value))
  const staffEntry = computed(() => capabilities.value !== null && capabilities.value.state !== 'forbidden')
  const routeAllowed = computed(() => canNavigateAdmin(router.currentRoute.value.path, capabilities.value))
  const requiresLogin = (path: string) => state.value.key === keyFor(path) && state.value.status === 'unauthenticated'
  return { cloudflare, capabilities, status, groups, staffEntry, routeAllowed, refresh, requiresLogin }
}
