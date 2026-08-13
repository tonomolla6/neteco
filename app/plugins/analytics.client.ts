export default defineNuxtPlugin((nuxtApp) => {
  const { track } = useAnalytics()
  nuxtApp.hook('page:finish', () => {
    const route = useRoute()
    void track('page_view', { path: route.path })
  })
})
