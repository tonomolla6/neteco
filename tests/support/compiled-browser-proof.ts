import { chromium, type Browser } from '@playwright/test'
import { connectRemoteTestBrowser } from '../../scripts/lib/remote-test-browser'

export interface CompiledBrowserProofOptions {
  required: boolean
  connect?: () => Promise<Browser>
}

/** HTTP/SSR contracts remain runnable independently. The required browser
 * gate must connect to the approved private browser; it has no fallback. */
export async function runCompiledBrowserProof(
  proof: (browser: Browser) => Promise<void>,
  options: CompiledBrowserProofOptions = { required: process.env.NETECO_COMPILED_BROWSER_REQUIRED === 'true' }
): Promise<{ browserExecuted: boolean }> {
  if (!options.required) return { browserExecuted: false }
  const browser = await (options.connect ?? (() => connectRemoteTestBrowser(chromium)))()
  try {
    await proof(browser)
    return { browserExecuted: true }
  } finally {
    await browser.close()
  }
}
