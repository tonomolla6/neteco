import type { BrowserType } from '@playwright/test'

export const REMOTE_BROWSER_NOT_RUN_REASON =
  'Browser checks were explicitly not run; no connection to the dedicated private SSH-forwarded browser service was attempted.'
export class RemoteTestBrowserError extends Error {
  constructor(
    readonly code: 'remote_browser_endpoint_missing' | 'remote_browser_endpoint_invalid' | 'remote_browser_unavailable'
  ) {
    super(
      code === 'remote_browser_endpoint_missing'
        ? 'Browser checks require PW_TEST_CONNECT_WS_ENDPOINT for the dedicated private SSH-forwarded Playwright service. Browser launch on the shared host is prohibited.'
        : code === 'remote_browser_endpoint_invalid'
          ? 'The remote browser endpoint must be a credential-free ws/wss URL on localhost or 127.0.0.1 through the private SSH forward. Browser launch on the shared host is prohibited.'
          : 'The dedicated Playwright browser could not be connected. Verify the private SSH forward and compatible Playwright versions; no browser fallback on the shared host was attempted.'
    )
    this.name = 'RemoteTestBrowserError'
  }
}

/** Connects only through the existing private SSH forward to the dedicated
 * server; never starts a browser or falls back on the shared host. */
export async function connectRemoteTestBrowser(
  browserType: Pick<BrowserType, 'connect'>,
  options: { endpoint?: string } = {}
) {
  const endpoint = options.endpoint ?? process.env.PW_TEST_CONNECT_WS_ENDPOINT
  if (!endpoint) throw new RemoteTestBrowserError('remote_browser_endpoint_missing')
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new RemoteTestBrowserError('remote_browser_endpoint_invalid')
  }
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.port ||
    /[\s\r\n]/.test(endpoint)
  )
    throw new RemoteTestBrowserError('remote_browser_endpoint_invalid')
  try {
    return await browserType.connect(endpoint, { exposeNetwork: '<loopback>', timeout: 10_000 })
  } catch {
    // Never preserve a provider error/cause: it may contain endpoint secrets.
    throw new RemoteTestBrowserError('remote_browser_unavailable')
  }
}
