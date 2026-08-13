import { applicationSecurityHeaders } from '../utils/security-headers'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const path = getRequestURL(event).pathname

  for (const [name, value] of Object.entries(applicationSecurityHeaders(config.appEnv))) setHeader(event, name, value)

  if (path.startsWith('/admin') || config.appEnv !== 'production') {
    setHeader(event, 'x-robots-tag', 'noindex, nofollow, noarchive')
  }
})
