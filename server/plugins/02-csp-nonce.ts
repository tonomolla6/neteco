import {
  applyCspNonceToRenderedHtml,
  bindCspNonceToResponse,
  CSP_NONCE_PLACEHOLDER,
  resolveCspMode,
  stripConditionalHeadersForNoncedDocument
} from '../../shared/csp'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    const config = useRuntimeConfig(event) as unknown as Record<string, unknown>
    stripConditionalHeadersForNoncedDocument(
      event.node.req.headers,
      resolveCspMode(config.cspMode ?? process.env.CSP_MODE)
    )
  })
  // The rendered HTML may be cached (SWR) and served to many requests: render with a
  // placeholder and bind the nonce of the current response's CSP header on the way out.
  nitroApp.hooks.hook('render:html', (html) => {
    applyCspNonceToRenderedHtml(html, CSP_NONCE_PLACEHOLDER)
  })
  nitroApp.hooks.hook('beforeResponse', (event, response) => {
    response.body = bindCspNonceToResponse(response.body, event.context.cspNonce as string | undefined)
  })
})
