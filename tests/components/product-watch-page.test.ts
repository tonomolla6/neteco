import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import Page from '../../app/pages/cuenta/avisos-productos.vue'
import pageSource from '../../app/pages/cuenta/avisos-productos.vue?raw'
import accountAuthMiddleware from '../../app/middleware/auth'
import {
  PRODUCT_WATCH_POLICY_VERSION,
  PRODUCT_WATCH_NOTICE_TEXT,
  productWatchIntentHash
} from '../../shared/product-watch'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn(), navigate: vi.fn(), auth: { value: null as unknown } }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.auth.value)
mockNuxtImport('navigateTo', () => mocks.navigate)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))
let wrapper: { unmount: () => void } | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

it('keeps an anonymous confirmation fragment out of login redirects and all requests, removing it before manual sign-in', async () => {
  mocks.auth.value = { ready: ref(true), loggedIn: ref(false), user: ref(null), session: ref(null) }
  mocks.request.mockReset()
  mocks.navigate.mockReset()
  const token = `pw1.10000000-0000-4000-8000-000000000087.${'a'.repeat(64)}`
  const fullPath = `/cuenta/avisos-productos#watchId=10000000-0000-4000-8000-000000000087&token=${token}`
  const script = parse(pageSource).descriptor.scriptSetup?.content
  if (!script) throw Error('Missing product-watch page script')
  const tree = ts.createSourceFile('avisos-productos.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const guards: string[] = []
  // Nuxt test-utils strips definePageMeta. Select the route's actual guard
  // using the SFC AST, then execute the real middleware, not a replica.
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'definePageMeta') {
      const metadata = node.arguments[0]
      if (!metadata || !ts.isObjectLiteralExpression(metadata)) throw Error('Unsupported route metadata')
      for (const property of metadata.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
          property.name.text === 'middleware'
        ) {
          if (!ts.isStringLiteral(property.initializer)) throw Error('Unsupported route guard')
          guards.push(property.initializer.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  const route = { fullPath } as Parameters<typeof accountAuthMiddleware>[0]
  if (guards.includes('auth')) await accountAuthMiddleware(route, route)
  expect(mocks.navigate.mock.calls.flat().join('')).not.toContain(token)
  expect(mocks.navigate.mock.calls.flat().join('')).not.toContain(encodeURIComponent(token))
  window.history.replaceState(null, '', fullPath)
  const page = await mountSuspended(Page)
  wrapper = page
  expect(window.location.hash).toBe('')
  expect(page.html()).not.toContain(token)
  expect(page.find('a[href="/login?redirect=%2Fcuenta%2Favisos-productos"]').exists()).toBe(true)
  expect(page.text()).toContain('reabre el enlace original')
  expect(mocks.request).not.toHaveBeenCalled()
})

it('confirms an authenticated email fragment only after manual review and exact receipt plus fresh detail', async () => {
  const id = '10000000-0000-4000-8000-000000000087',
    now = '2030-01-02T00:00:00Z',
    token = `pw1.${id}.${'b'.repeat(64)}`
  mocks.auth.value = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: '10000000-0000-4000-8000-000000000050', emailVerified: true }),
    session: ref({ sessionId: '20000000-0000-4000-8000-000000000050', sessionVersion: 1 })
  }
  mocks.navigate.mockReset()
  let confirmed = false
  const item = () => ({
    id,
    variantId: 11,
    kind: 'price_drop',
    status: confirmed ? 'confirmed' : 'pending',
    version: confirmed ? 2 : 1,
    createdAt: now,
    confirmationExpiresAt: '2030-01-04T00:00:00Z',
    confirmedAt: confirmed ? now : null,
    cancelledAt: null,
    baselineGrossCents: confirmed ? 500 : null,
    suppressedByPreferences: true,
    notifications: 0
  })
  mocks.request.mockReset().mockImplementation(
    async (
      path: string,
      options: {
        method?: string
        body?: { expectedVersion: number; token: string }
        headers?: Record<string, string>
      } = {}
    ) => {
      if (options.method === 'POST') {
        confirmed = true
        return {
          source: 'cloudflare',
          commandId: options.headers!['Idempotency-Key'],
          action: 'confirm',
          watchId: id,
          payloadHash: await productWatchIntentHash('confirm', id, options.body),
          version: 2,
          status: 'confirmed',
          recordedAt: now,
          inventoryEffect: 'none',
          economicEffect: 'none'
        }
      }
      if (path.endsWith(id)) return { source: 'cloudflare', item: item(), evaluatedAt: now }
      return {
        source: 'cloudflare',
        page: 1,
        perPage: 25,
        total: 1,
        items: [item()],
        policyVersion: PRODUCT_WATCH_POLICY_VERSION,
        noticeText: PRODUCT_WATCH_NOTICE_TEXT,
        evaluatedAt: now
      }
    }
  )
  window.history.replaceState(null, '', `/cuenta/avisos-productos#watchId=${id}&token=${token}`)
  const page = await mountSuspended(Page)
  wrapper = page
  await vi.waitFor(() => expect(page.find('[data-watch-email-confirm]').exists()).toBe(true))
  expect(window.location.hash).toBe('')
  expect(page.html()).not.toContain(token)
  expect(mocks.navigate).not.toHaveBeenCalled()
  expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  await page.get('[data-watch-email-confirm]').trigger('click')
  await vi.waitFor(() => expect(page.find('[data-watch-confirm]').exists()).toBe(true))
  expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  const beforeDetail = mocks.request.mock.calls.filter(([path]) => path === `/api/account/product-watches/${id}`).length
  await page.get('[data-watch-confirm]').trigger('click')
  await vi.waitFor(() => expect(page.text()).toContain('· Confirmado'))
  const posts = mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(posts[0]![0]).toBe(`/api/account/product-watches/${id}/confirm`)
  expect(posts[0]![1].body).toEqual({ expectedVersion: 1, token })
  expect(
    mocks.request.mock.calls.filter(([path]) => path === `/api/account/product-watches/${id}`).length
  ).toBeGreaterThan(beforeDetail)
  expect(mocks.request.mock.calls.map(([path]) => path).join('')).not.toContain(token)
})
