import assert from 'node:assert/strict'
import { expect, type Browser } from '@playwright/test'
import {
  cartRecoveryIntentHash,
  cartRecoveryReceiptSchema,
  cartRecoveryResolveInputSchema,
  cartRecoveryResolvedSchema,
  cartRecoveryResumeInputSchema,
  type CartRecoveryReceipt,
  type CartRecoveryResumeInput
} from '../../shared/cart-recovery'

export const CART_RECOVERY_BROWSER_SCENARIOS = [
  'native_cart_recovery_compiled_resume_revocation_desktop',
  'native_cart_recovery_compiled_resume_revocation_mobile'
] as const
export interface CartRecoveryBrowserFixture {
  customerCookie: string
  capability: { id: string; token: string }
  cartId: string
  cartVersion: number
}
export interface CartRecoveryResumeProof {
  body: CartRecoveryResumeInput
  receipt: CartRecoveryReceipt
}
export interface NativeCartRecoveryBrowserInput {
  origin: string
  browser: Pick<Browser, 'newContext'>
  dispatch: (request: Request) => Promise<Response>
  prepare: (viewport: 'desktop' | 'mobile') => Promise<CartRecoveryBrowserFixture>
  readCommittedResume: (proof: CartRecoveryResumeProof) => Promise<void>
  revokeCapability: (fixture: CartRecoveryBrowserFixture) => Promise<void>
  assertEconomicUnchanged: () => Promise<void>
  scenario?: (id: string) => void
}
export interface CartRecoveryBrowserBridgeInput {
  origin: string
  fixture: CartRecoveryBrowserFixture
  dispatch: (request: Request) => Promise<Response>
  readCommittedResume: (proof: CartRecoveryResumeProof) => Promise<void>
}
const root = '/api/account/cart-recovery'
export type CartRecoveryBrowserStage =
  | 'prepare'
  | 'context'
  | 'navigation'
  | 'reopen'
  | 'resolve'
  | 'review'
  | 'resume'
  | 'revocation'
  | 'denial'
  | 'transport'
  | 'transport-capabilities'
  | 'transport-exception'
  | 'page-errors'
  | 'completion'
  | 'cleanup'
export class CartRecoveryBrowserError extends Error {
  constructor(
    readonly stage: CartRecoveryBrowserStage,
    readonly viewport: 'desktop' | 'mobile' | null
  ) {
    super(`Isolated compiled cart recovery browser check failed: ${stage}/${viewport ?? 'none'}`)
    this.name = 'CartRecoveryBrowserError'
  }
}
function isolated(origin: string) {
  assert.equal(origin, 'https://shop-audit.neteco.test')
}
export function createCartRecoveryBrowserBridge(input: CartRecoveryBrowserBridgeInput) {
  isolated(input.origin)
  const capability = cartRecoveryResolveInputSchema.parse(input.fixture.capability)
  let submitted = false
  const counts = { resolvePosts: 0, resumePosts: 0, provenResumes: 0, deniedResolves: 0 }
  return {
    counts,
    async forward(
      request: Request
    ): Promise<{ action: 'fulfill'; response: Response } | { action: 'abort'; reason: string }> {
      const url = new URL(request.url)
      if (url.origin !== input.origin || url.hash || url.href.includes(capability.token))
        return { action: 'abort', reason: 'unsafe_request' }
      const resolve = request.method === 'POST' && url.pathname === root + '/resolve' && !url.search,
        resume = request.method === 'POST' && url.pathname === root + '/resume' && !url.search,
        privacy = request.method === 'DELETE' && url.pathname === '/api/analytics/session' && !url.search
      if (url.pathname.startsWith(root) && url.search) return { action: 'abort', reason: 'capability_query_forbidden' }
      const read =
        request.method === 'GET' &&
        !url.search &&
        ([
          '/api/cart',
          '/api/_auth/session',
          '/api/categories',
          '/cuenta/recuperar-carrito',
          root + '/preferences',
          '/logo-figura.png',
          '/logo-texto.png',
          '/favicon.png',
          '/favicon.ico'
        ].includes(url.pathname) ||
          /^\/_nuxt\/[A-Za-z0-9_./-]+$/.test(url.pathname))
      if (!read && !resolve && !resume && !privacy) return { action: 'abort', reason: 'unapproved_request' }
      let body: CartRecoveryResumeInput | null = null
      if (resolve || resume) {
        assert.equal(request.headers.get('origin'), input.origin)
        assert(
          (request.headers.get('cookie') ?? '')
            .split(';')
            .map((part) => part.trim())
            .includes(input.fixture.customerCookie)
        )
        const raw: unknown = await request.clone().json(),
          parsed = resolve ? cartRecoveryResolveInputSchema.parse(raw) : cartRecoveryResumeInputSchema.parse(raw)
        assert.equal(parsed.id, capability.id)
        assert(parsed.token === capability.token, 'unexpected_recovery_capability')
        if (resume) {
          assert.equal(submitted, false, 'Automatic resume replay is forbidden')
          submitted = true
          body = cartRecoveryResumeInputSchema.parse(parsed)
          assert.equal(body.expectedCartVersion, input.fixture.cartVersion)
          counts.resumePosts++
        } else counts.resolvePosts++
      }
      // Preserve actual browser cookies: in particular never replace the
      // rotated HttpOnly cart credential with the fixture's original value.
      const response = await input.dispatch(request)
      if (resolve && response.status === 404) counts.deniedResolves++
      if (resolve && response.ok) {
        const resolved = cartRecoveryResolvedSchema.parse(await response.clone().json())
        if (
          resolved.associationId !== capability.id ||
          resolved.cartId !== input.fixture.cartId ||
          resolved.cartVersion !== input.fixture.cartVersion
        )
          throw new Error('unconfirmed_recovery_snapshot')
      }
      if (resume && response.ok && body) {
        const receipt = cartRecoveryReceiptSchema.parse(await response.clone().json())
        assert.equal(response.status, 201)
        assert.equal(receipt.action, 'resume')
        assert.equal(receipt.commandId, request.headers.get('idempotency-key'))
        assert.equal(receipt.payloadHash, await cartRecoveryIntentHash('resume', body))
        assert.equal(receipt.associationId, capability.id)
        assert.equal(receipt.cartVersion, input.fixture.cartVersion + 1)
        const grant = response.headers.getSetCookie().filter((value) => value.startsWith('neteco-cart-v2='))
        const match =
          grant.length === 1 ? /^neteco-cart-v2=v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43});/i.exec(grant[0]!) : null
        const attributes =
          grant[0]
            ?.split(';')
            .slice(1)
            .map((part) => part.trim().toLowerCase()) ?? []
        if (
          !match ||
          match[1] !== input.fixture.cartId ||
          !['httponly', 'secure', 'samesite=lax', 'path=/'].every((value) => attributes.includes(value))
        )
          throw new Error('unconfirmed_possession_grant')
        await input.readCommittedResume({ body, receipt })
        counts.provenResumes++
      }
      return { action: 'fulfill', response }
    }
  }
}
export async function auditNativeCartRecoveryBrowser(input: NativeCartRecoveryBrowserInput) {
  let stage: CartRecoveryBrowserStage = 'prepare',
    activeViewport: 'desktop' | 'mobile' | null = null,
    transportStage: 'transport' | 'transport-capabilities' | 'transport-exception' = 'transport'
  try {
    isolated(input.origin)
    const completed: string[] = []
    for (const [index, viewport] of (['desktop', 'mobile'] as const).entries()) {
      activeViewport = viewport
      stage = 'prepare'
      const fixture = await input.prepare(viewport),
        bridge = createCartRecoveryBrowserBridge({ ...input, fixture })
      stage = 'context'
      const context = await input.browser.newContext({
        locale: 'es-ES',
        serviceWorkers: 'block',
        viewport: viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 }
      })
      let transportFailed = false,
        pageErrors = 0,
        leaked = false
      try {
        const separator = fixture.customerCookie.indexOf('=')
        assert(separator > 0 && !fixture.customerCookie.includes(';'))
        await context.addCookies([
          {
            name: fixture.customerCookie.slice(0, separator),
            value: fixture.customerCookie.slice(separator + 1),
            url: input.origin,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
          }
        ])
        await context.route('**/*', async (route) => {
          try {
            const incoming = route.request(),
              headers = await incoming.allHeaders(),
              bytes = incoming.postDataBuffer()
            headers['accept-encoding'] = 'identity'
            const result = await bridge.forward(
              new Request(incoming.url(), {
                method: incoming.method(),
                headers,
                redirect: 'manual',
                ...(bytes ? { body: Uint8Array.from(bytes).buffer } : {})
              })
            )
            if (result.action === 'abort') {
              transportFailed = true
              if (new URL(incoming.url()).pathname === '/api/admin/capabilities')
                transportStage = 'transport-capabilities'
              await route.abort('failed')
            } else {
              const headers = Object.fromEntries(result.response.headers)
              delete headers['content-encoding']
              delete headers['content-length']
              await route.fulfill({
                status: result.response.status,
                headers,
                body: Buffer.from(await result.response.arrayBuffer())
              })
            }
          } catch {
            transportFailed = true
            transportStage = 'transport-exception'
            await route.abort('failed')
          }
        })
        const page = await context.newPage()
        page.on('pageerror', () => {
          pageErrors++
        })
        page.on('console', (message) => {
          if (message.text().includes(fixture.capability.token)) leaked = true
        })
        const entry = input.origin + '/cuenta/recuperar-carrito#' + new URLSearchParams(fixture.capability)
        const open = async (reopening = false) => {
          stage = reopening ? 'reopen' : 'navigation'
          await page.goto(entry, { waitUntil: 'domcontentloaded' })
          await expect.poll(() => new URL(page.url()).hash).toBe('')
          assert.equal(new URL(page.url()).search, '')
          const reject = page.getByRole('button', { name: 'Rechazar opcionales', exact: true })
          if (await reject.isVisible()) await reject.click()
          await expect(page.locator('[data-recovery-resolve]')).toBeEnabled()
        }
        const noSecret = async () => {
          assert.equal((await page.content()).includes(fixture.capability.token), false)
          assert.equal(
            await page.evaluate(
              (token) =>
                [localStorage, sessionStorage].some((storage) =>
                  Object.keys(storage).some(
                    (key) => key.includes(token) || (storage.getItem(key) ?? '').includes(token)
                  )
                ),
              fixture.capability.token
            ),
            false
          )
          assert.equal(leaked, false)
        }
        await open()
        await noSecret()
        assert.equal(bridge.counts.resumePosts, 0)
        stage = 'resolve'
        await page.locator('[data-recovery-resolve]').click()
        await expect(page.locator('[data-recovery-review-resume]')).toBeEnabled()
        stage = 'review'
        await page.locator('[data-recovery-review-resume]').click()
        await expect(page.locator('[data-recovery-confirm]')).toBeEnabled()
        assert.equal(bridge.counts.resumePosts, 0)
        stage = 'resume'
        await page.locator('[data-recovery-confirm]').click()
        await expect(
          page.getByText('El carrito se ha retomado y comprobado. Revisa el envío antes de realizar un pedido.', {
            exact: true
          })
        ).toBeVisible()
        assert.equal(bridge.counts.resumePosts, 1)
        assert.equal(bridge.counts.provenResumes, 1)
        const cookies = await context.cookies(input.origin),
          possession = cookies.filter((cookie) => cookie.name === 'neteco-cart-v2')
        assert.equal(possession.length, 1)
        assert(possession[0]!.httpOnly && possession[0]!.secure && possession[0]!.sameSite === 'Lax')
        assert(possession[0]!.value.startsWith('v1.' + fixture.cartId + '.'))
        await noSecret()
        await input.assertEconomicUnchanged()
        stage = 'revocation'
        await input.revokeCapability(fixture)
        await open(true)
        stage = 'denial'
        await page.locator('[data-recovery-resolve]').click()
        await expect(
          page.getByText('No se ha podido verificar la recuperación. Vuelve a consultar.', { exact: true })
        ).toBeVisible()
        assert.equal(bridge.counts.deniedResolves, 1)
        await expect(page.locator('[data-recovery-review-resume]')).toHaveCount(0)
        assert.equal(bridge.counts.resumePosts, 1)
        await noSecret()
        await input.assertEconomicUnchanged()
        stage = transportStage
        assert.equal(transportFailed, false)
        stage = 'page-errors'
        assert.equal(pageErrors, 0)
        stage = 'completion'
        const id = CART_RECOVERY_BROWSER_SCENARIOS[index]!
        completed.push(id)
        input.scenario?.(id)
      } finally {
        const previousStage = stage
        stage = 'cleanup'
        await context.close()
        stage = previousStage
      }
    }
    return {
      browserExecuted: true,
      scenarios: completed.length,
      completed,
      providerSubmission: false,
      productionBrowserAcceptance: false
    }
  } catch {
    // Transport and cleanup exceptions may contain the capability URL.
    // Preserve only finite context, never the raw message or cause.
    throw new CartRecoveryBrowserError(stage, activeViewport)
  }
}
