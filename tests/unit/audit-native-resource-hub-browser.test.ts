import type { Browser, BrowserContextOptions } from '@playwright/test'
import { expect, it, vi } from 'vitest'
import {
  auditNativeResourceHubBrowser,
  RESOURCE_HUB_BROWSER_SCENARIOS,
  type ResourceHubBrowserFixture
} from '../../scripts/lib/audit-native-resource-hub-browser'

const origin = 'https://shop-audit.neteco.test'
const originalCookie = 'ordinary-consent=synthetic'
const fixture: ResourceHubBrowserFixture = {
  slug: 'guia-publicada',
  expiredSlug: 'guia-caducada',
  title: 'Guía profesional sintética',
  description: 'Descripción editorial revisada sintética.',
  content: 'Contenido revisado sintético.',
  author: 'Autora sintética'
}
type FakeRoute = {
  request(): { url(): string; method(): string; allHeaders(): Promise<Record<string, string>>; postDataBuffer(): null }
  fulfill(options: unknown): Promise<void>
  abort(reason?: string): Promise<void>
}

// Explicit control-flow double only. These tests do NOT establish browser,
// hydration, SSR or compiled-renderer acceptance; ROOT runs that separately.
function harness(options: { badCanonical?: boolean; expiredStatus?: number; external?: boolean } = {}) {
  const events: string[] = []
  const contexts: BrowserContextOptions[] = []
  const closed: number[] = []
  const aborted: string[] = []
  const dispatch = vi.fn(async (request: Request) => {
    events.push(`dispatch:${new URL(request.url).pathname}`)
    if (new URL(request.url).pathname === '/api/resources/' + fixture.expiredSlug)
      return Response.json({ error: { code: 'not_found' } }, { status: options.expiredStatus ?? 404 })
    return new Response('<html>synthetic transport payload</html>', { headers: { 'content-type': 'text/html' } })
  })
  const browser = {
    close: vi.fn(async () => {
      throw new Error('Caller-owned browser must not be closed')
    }),
    async newContext(settings: BrowserContextOptions) {
      const index = contexts.push(settings) - 1
      let handler: ((route: FakeRoute) => Promise<void>) | undefined
      let currentUrl = origin + '/recursos'
      const navigate = async (url: string) => {
        currentUrl = url
        events.push(`goto:${index}:${url}`)
        const address = options.external ? 'https://external.invalid/tracker' : url
        if (handler)
          await handler({
            request: () => ({
              url: () => address,
              method: () => 'GET',
              allHeaders: async () => ({ cookie: originalCookie }),
              postDataBuffer: () => null
            }),
            fulfill: async () => undefined,
            abort: async () => {
              aborted.push(address)
            }
          })
        return { status: () => 200 }
      }
      const locator = (selector: string) => ({
        first() {
          return this
        },
        async waitFor() {},
        async isVisible() {
          return false
        },
        async count() {
          return 1
        },
        async innerText() {
          return `${fixture.title} ${fixture.description} ${fixture.author} ${fixture.content}`
        },
        async textContent() {
          return `${fixture.title} ${fixture.description} ${fixture.author} ${fixture.content}`
        },
        async getAttribute(name: string) {
          if (name === 'content') return fixture.description
          if (name === 'href') {
            if (selector.includes('canonical'))
              return (options.badCanonical ? 'https://external.invalid' : origin) + '/recursos/' + fixture.slug
            return '/recursos/' + fixture.slug
          }
          return null
        },
        async click() {
          events.push(`click:${index}:${fixture.title}`)
          await navigate(origin + '/recursos/' + fixture.slug)
        }
      })
      const page = {
        goto: navigate,
        url: () => currentUrl,
        async waitForURL() {},
        async title() {
          return fixture.title + ' · Neteco'
        },
        locator,
        getByRole: (_role: string, args?: { name?: string }) => locator(args?.name ?? ''),
        on: () => undefined,
        async evaluate() {
          return true
        }
      }
      return {
        async route(_pattern: string, callback: typeof handler) {
          handler = callback
        },
        async newPage() {
          return page
        },
        async close() {
          closed.push(index)
        }
      }
    }
  }
  return { browser: browser as unknown as Browser, dispatch, events, contexts, closed, aborted }
}

it('drives two viewports and a JavaScript-disabled list-to-detail control, closing only owned contexts', async () => {
  const h = harness(),
    scenario = vi.fn()
  const result = await auditNativeResourceHubBrowser({ ...h, origin, fixture, scenario })
  expect(result).toMatchObject({
    scenarios: 3,
    browserExecuted: true,
    productionBrowserAcceptance: false,
    providerSubmission: false
  })
  expect(result.viewports).toHaveLength(3)
  expect(h.contexts.map((context) => context.javaScriptEnabled)).toEqual([true, true, false])
  expect(h.contexts[0]!.viewport!.width).toBeGreaterThan(1000)
  expect(h.contexts[1]!.viewport!.width).toBeLessThan(500)
  expect(h.events.filter((event) => event.startsWith('click:'))).toHaveLength(3)
  expect(h.closed).toEqual([0, 1, 2])
  expect(h.browser.close).not.toHaveBeenCalled()
  expect(scenario.mock.calls.map(([id]) => id)).toEqual([...RESOURCE_HUB_BROWSER_SCENARIOS])
  expect(
    h.dispatch.mock.calls.some(([request]) => request.url === origin + '/api/resources/' + fixture.expiredSlug)
  ).toBe(true)
  expect(
    h.dispatch.mock.calls.find(([request]) => request.url === origin + '/recursos')![0].headers.get('cookie')
  ).toBe(originalCookie)
})

it('fails a mismatched canonical instead of reporting a successful scenario, and closes the context', async () => {
  const h = harness({ badCanonical: true }),
    scenario = vi.fn()
  await expect(auditNativeResourceHubBrowser({ ...h, origin, fixture, scenario })).rejects.toThrow(/canonical/i)
  expect(h.closed).toEqual([0])
  expect(scenario).not.toHaveBeenCalled()
  expect(h.browser.close).not.toHaveBeenCalled()
})

it('requires the actual expired resource response to be 404', async () => {
  const h = harness({ expiredStatus: 200 }),
    scenario = vi.fn()
  await expect(auditNativeResourceHubBrowser({ ...h, origin, fixture, scenario })).rejects.toThrow(/expired|caducad/i)
  expect(scenario).not.toHaveBeenCalled()
})

it('aborts external browser requests without forwarding them or claiming acceptance', async () => {
  const h = harness({ external: true }),
    scenario = vi.fn()
  await expect(auditNativeResourceHubBrowser({ ...h, origin, fixture, scenario })).rejects.toThrow(
    /external|transport/i
  )
  expect(h.aborted).toContain('https://external.invalid/tracker')
  expect(h.dispatch.mock.calls.every(([request]) => new URL(request.url).origin === origin)).toBe(true)
  expect(h.closed).toEqual([0])
  expect(scenario).not.toHaveBeenCalled()
})
