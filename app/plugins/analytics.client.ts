import { isPrivateAnalyticsRoute } from '~~/shared/analytics-privacy'

export default defineNuxtPlugin((nuxtApp) => {
  const { track } = useAnalytics()
  nuxtApp.hook('page:finish', () => {
    const route = useRoute()
    if (isPrivateAnalyticsRoute(route.path, route.query)) return
    void track('page_view', { path: route.path })
  })
})
