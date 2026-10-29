import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditNativeCartAddRecoveryBrowser } from '../../scripts/lib/audit-native-cart-add-recovery-browser'
import { REMOTE_BROWSER_NOT_RUN_REASON } from '../../scripts/lib/remote-test-browser'

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), connect: vi.fn(), browser: vi.fn() }))
vi.mock('@playwright/test', async (original) => ({
  ...(await original<typeof import('@playwright/test')>()),
  // Fail closed if a regression tries any local launch or direct connection.
  chromium: { launch: mocks.browser, launchServer: mocks.browser, connect: mocks.browser }
}))
vi.mock('../../scripts/lib/remote-test-browser', async (original) => ({
  ...(await original<typeof import('../../scripts/lib/remote-test-browser')>()),
  connectRemoteTestBrowser: mocks.connect
}))
const valid = () => ({
  dispatch: mocks.dispatch,
  origin: 'https://shop-audit.neteco.test',
  productSlug: 'synthetic-local-product',
  variantLegacyId: 11,
  browserMode: 'not-run' as const
})
beforeEach(() => {
  mocks.dispatch.mockReset().mockRejectedValue(new Error('unexpected_dispatch'))
  mocks.connect.mockReset().mockRejectedValue(new Error('unexpected_browser_connection'))
  mocks.browser.mockReset().mockRejectedValue(new Error('unexpected_browser_operation'))
})
afterEach(() => {
  expect(mocks.browser).not.toHaveBeenCalled()
})

describe('cart ADD browser acceptance invocation guards, not browser acceptance', () => {
  it('records NOTRUN with zero dispatches, browser connections and executed scenarios', async () => {
    const scenario = vi.fn()
    const result = await auditNativeCartAddRecoveryBrowser({ ...valid(), scenario })
    expect(result).toMatchObject({
      scenarios: 0,
      browserStatus: 'not_run',
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      engine: null,
      transport: null,
      journeys: [],
      syntheticSessionOnly: true,
      providerSubmission: false,
      productionBrowserAcceptance: false
    })
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(scenario).not.toHaveBeenCalled()
  })
  it.each([
    'http://shop-audit.neteco.test',
    'https://neteco.es',
    'https://shop-audit.neteco.test/path',
    'https://shop-audit.neteco.test?token=private',
    'https://user:secret@shop-audit.neteco.test',
    'not-a-url'
  ])('rejects invalid origin %s before any dispatch or browser connection', async (origin) => {
    await expect(auditNativeCartAddRecoveryBrowser({ ...valid(), origin })).rejects.toThrow()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })
  it.each(['', '../producto', 'producto?sku=private', 'producto/con-ruta', 'producto con espacios'])(
    'rejects invalid product slug %j before any dispatch or browser connection',
    async (productSlug) => {
      await expect(auditNativeCartAddRecoveryBrowser({ ...valid(), productSlug })).rejects.toThrow()
      expect(mocks.dispatch).not.toHaveBeenCalled()
      expect(mocks.connect).not.toHaveBeenCalled()
    }
  )
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid legacy variant ID %s before any dispatch or browser connection',
    async (variantLegacyId) => {
      await expect(auditNativeCartAddRecoveryBrowser({ ...valid(), variantLegacyId })).rejects.toThrow()
      expect(mocks.dispatch).not.toHaveBeenCalled()
      expect(mocks.connect).not.toHaveBeenCalled()
    }
  )
})
