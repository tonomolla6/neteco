import { applicationSecurityHeaders } from '../utils/security-headers'
import { robotsHeader } from '../utils/robots'
import { generateCspNonce, resolveCspMode } from '../../shared/csp'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const path = getRequestURL(event).pathname
  const cspMode = resolveCspMode((config as unknown as Record<string, unknown>).cspMode ?? process.env.CSP_MODE)
  const nonce = generateCspNonce()
  event.context.cspNonce = nonce

  for (const [name, value] of Object.entries(
    applicationSecurityHeaders(config.appEnv, { strict: true, cspMode, nonce })
  )) {
    setHeader(event, name, value)
  }

  const robots = robotsHeader(config.appEnv, path)
  if (robots) setHeader(event, 'x-robots-tag', robots)
})
