import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { adminNavigationGroups, canNavigateAdmin } from '~~/shared/admin-navigation'

export default defineNuxtRouteMiddleware(async (to) => {
  const { loggedIn, user } = useUserSession()

  if (!loggedIn.value) {
    return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
  }

  if (useRuntimeConfig().public.serverRuntime === 'cloudflare') {
    const navigation = useAdminNavigation()
    const capabilities = await navigation.refresh(to.fullPath)
    if (navigation.requiresLogin(to.fullPath)) return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
    if (!capabilities || capabilities.state !== 'ready') return to.path === '/admin' ? undefined : navigateTo('/admin')
    if (canNavigateAdmin(to.path, capabilities)) return undefined
    const destination = adminNavigationGroups(capabilities).flatMap((group) => group.links)[0]?.to
    return destination && destination !== to.path ? navigateTo(destination) : undefined
  }

  if (user.value?.role !== 'admin') {
    return navigateTo('/')
  }

  // Toda la API del panel exige MFA (`requireAdmin` → `requirePermission(..., { mfa: true })`),
  // pero este middleware solo comprobaba el rol. Un administrador sin MFA entraba, veía la
  // navegación completa y recibía un error rojo genérico en cada pantalla, sin que nada le
  // dijera que el problema era la verificación en dos pasos. El shell del panel muestra
  // ahora un aviso con la ruta para activarla; no se bloquea la navegación para que pueda
  // llegar a ella y entender qué le falta.
  return undefined
})
