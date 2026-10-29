import { supportContactDocumentTarget } from '~~/shared/support-navigation'

export default defineNuxtRouteMiddleware((to) => {
  if (!import.meta.client) return
  const target = supportContactDocumentTarget(useRuntimeConfig().public.serverRuntime, window.location.pathname, to)
  if (target) return navigateTo(target, { external: true })
})
