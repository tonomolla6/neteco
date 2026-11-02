import { applicationSecurityHeaders } from '../utils/security-headers'
import { robotsHeader } from '../utils/robots'
import { generateCspNonce, resolveCspMode } from '../../shared/csp'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const url = getRequestURL(event)
  const path = url.pathname
  const cspMode = resolveCspMode((config as unknown as Record<string, unknown>).cspMode ?? process.env.CSP_MODE)
  const nonce = generateCspNonce()
  event.context.cspNonce = nonce

  for (const [name, value] of Object.entries(
    applicationSecurityHeaders(config.appEnv, {
      strict: true,
      cspMode,
      nonce,
      // Over plain http (local/E2E) an enforced upgrade would push every request to https.
      upgradeInsecureRequests: config.appEnv === 'production' || url.protocol === 'https:'
    })
  )) {
    setHeader(event, name, value)
  }

  const robots = robotsHeader(config.appEnv, path)
  if (robots) setHeader(event, 'x-robots-tag', robots)
})
