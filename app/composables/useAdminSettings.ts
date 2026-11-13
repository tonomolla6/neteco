import { adminSettingsSchema, type AdminServiceKey, type AdminSettings } from '~~/shared/admin-settings'

/**
 * Configuración efectiva de la tienda (solo lectura) para Ajustes y para explicar, en vez
 * de enseñar un error, que una pantalla depende de un servicio que no está activado.
 * Se lee una vez por visita al panel; sin respuesta no se afirma nada (`settings` nulo).
 */
export function useAdminSettings() {
  const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
  const state = useState<{ status: 'idle' | 'pending' | 'ready' | 'error'; settings: AdminSettings | null }>(
    'admin-settings',
    () => ({ status: 'idle', settings: null })
  )
  async function load(force = false) {
    if (!cloudflare || !import.meta.client) return
    if (!force && (state.value.status === 'pending' || state.value.status === 'ready')) return
    state.value = { status: 'pending', settings: state.value.settings }
    try {
      const settings = adminSettingsSchema.parse(await $fetch<unknown>('/api/admin/settings', { cache: 'no-store' }))
      state.value = { status: 'ready', settings }
    } catch {
      state.value = { status: 'error', settings: null }
    }
  }
  onMounted(() => void load())
  return {
    /** `false` fuera de Cloudflare: allí la configuración vive en el servidor Node y no se proyecta. */
    available: cloudflare,
    status: computed(() => state.value.status),
    settings: computed(() => state.value.settings),
    /** `true` solo cuando se sabe con certeza que el servicio está apagado. */
    serviceOff: (service: AdminServiceKey) => state.value.settings?.services[service] === false,
    refresh: () => load(true)
  }
}
