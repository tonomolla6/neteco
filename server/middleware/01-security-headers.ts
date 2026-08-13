import { applicationSecurityHeaders } from '../utils/security-headers'
import { robotsHeader } from '../utils/robots'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const path = getRequestURL(event).pathname

  for (const [name, value] of Object.entries(applicationSecurityHeaders(config.appEnv))) setHeader(event, name, value)

  const robots = robotsHeader(config.appEnv, path)
  if (robots) setHeader(event, 'x-robots-tag', robots)
})
