export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn, user } = useUserSession()
  if (!loggedIn.value) return navigateTo('/login?redirect=' + encodeURIComponent(to.fullPath))
  // API, not client role labels, determines support.manage and current MFA.
  if (useRuntimeConfig().public.serverRuntime !== 'cloudflare' && user.value?.role !== 'admin') return navigateTo('/')
})
