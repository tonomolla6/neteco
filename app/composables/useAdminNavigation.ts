import {
  adminCapabilitiesSchema,
  ADMIN_NAVIGATION_PERMISSIONS,
  adminNavigationGroups,
  adminNavigationTree,
  canNavigateAdmin,
  type AdminCapabilities
} from '~~/shared/admin-navigation'

// Request-scoped on SSR, ephemeral in the browser; promises are never serialized
// into payload state. Only identical concurrent reads share a request.
const pendingReads = new WeakMap<
  object,
  Map<string, { generation: number; promise: Promise<AdminCapabilities | null> }>
>()

const LEGACY_PATHS = new Set([
  '/admin',
  '/admin/pedidos',
  '/admin/devoluciones',
  '/admin/soporte',
  '/admin/clientes',
  '/admin/productos',
  '/admin/categorias',
  '/admin/precios',
  '/admin/medios',
  '/admin/contenido',
  '/admin/operaciones',
  '/admin/busqueda'
])

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
  // The Node runtime has no capability endpoint: its panel exposes this fixed set.
  const tree = computed(() => {
    if (cloudflare.value) return adminNavigationTree(capabilities.value)
    const everything = adminNavigationTree({
      source: 'cloudflare',
      identityId: '',
      sessionId: '',
      sessionVersion: 1,
      state: 'ready',
      permissions: [...ADMIN_NAVIGATION_PERMISSIONS]
    })
    return everything
      .map((section) => ({
        ...section,
        items: section.items
          .map((item) => ({ ...item, tabs: item.tabs.filter((entry) => LEGACY_PATHS.has(entry.to)) }))
          .filter((item) => item.tabs.length > 0)
      }))
      .filter((section) => section.items.length > 0)
  })
  const staffEntry = computed(() => capabilities.value !== null && capabilities.value.state !== 'forbidden')
  const routeAllowed = computed(() => canNavigateAdmin(router.currentRoute.value.path, capabilities.value))
  const requiresLogin = (path: string) => state.value.key === keyFor(path) && state.value.status === 'unauthenticated'
  return { cloudflare, capabilities, status, groups, tree, staffEntry, routeAllowed, refresh, requiresLogin }
}
