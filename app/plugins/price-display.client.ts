/**
 * Aplica la preferencia de precios (sin IVA / con IVA) una vez hidratada la página, y la
 * recalcula si cambia la sesión: al entrar con una cuenta de empresa se pasa a neto salvo
 * que el visitante ya hubiera elegido.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const { applyVisitorPreference } = usePriceDisplay()
  const { user } = useUserSession()
  const apply = () => applyVisitorPreference(!!user.value?.company)
  let hydrated = false
  nuxtApp.hook('app:suspense:resolve', () => {
    if (hydrated) return
    hydrated = true
    apply()
    watch(() => user.value?.company ?? null, apply)
  })
})
