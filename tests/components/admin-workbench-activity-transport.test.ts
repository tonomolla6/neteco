import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import AdminRecentActivity from '../../app/components/AdminRecentActivity.vue'
import { adminActivityResponseSchema } from '../../shared/admin-activity'
import {
  createWorkbenchBrowserBridge,
  allowsOrderOperationsForeignRead
} from '../../scripts/lib/audit-native-order-operations-browser'
import '#app/nuxt-vitest-app-entry'

// The Playwright route bridge receives Node transport objects, not browser
// fetch objects (Happy DOM strips their forbidden Cookie header).
const nodeFetch = createRequire(import.meta.url)('undici') as typeof import('undici')
const TransportRequest = nodeFetch.Request as unknown as typeof Request
const TransportResponse = nodeFetch.Response as unknown as typeof Response

// This test exercises the exported transport policies, not the browser runner.
// Fail loudly if a policy unexpectedly crosses a Playwright boundary.
vi.mock('@playwright/test', () => ({
  chromium: {
    connect: () => {
      throw new Error('Browser connection is forbidden in component transport tests')
    },
    launch: () => {
      throw new Error('Browser launch is forbidden in component transport tests')
    }
  },
  expect: () => {
    throw new Error('Playwright assertions are forbidden in component transport tests')
  }
}))

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const origin = 'https://shop-audit.neteco.test'
const sessionCookie = 'neteco-session=synthetic-activity-session'
const originalCookie = sessionCookie + '; ordinary-consent=synthetic'
type Transport = 'owned_workbench' | 'foreign_read'
type FetchOptions = {
  method: string
  query: Record<string, string | number>
  cache: RequestCache
  retry: number
  signal: AbortSignal
}
const mounted: Array<Awaited<ReturnType<typeof mountSuspended>>> = []
beforeEach(() => {
  mocks.request.mockReset()
})
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

function boundary(transport: Transport) {
  const dispatched: Request[] = []
  const dispatch = async (request: Request) => {
    dispatched.push(request.clone())
    return TransportResponse.json(
      adminActivityResponseSchema.parse({ source: 'cloudflare', items: [], nextCursor: null })
    )
  }
  const bridge = createWorkbenchBrowserBridge({
    origin,
    dispatch,
    bulk: {
      adminCookie: sessionCookie,
      orderIds: ['10000000-0000-4000-8000-000000000086'],
      async readCommittedBulk() {
        throw new Error('Activity must not read a bulk commit')
      },
      async consumeBulkQueue() {
        throw new Error('Activity must not consume a queue')
      }
    }
  })
  return {
    dispatched,
    async forward(request: Request): Promise<Response | null> {
      if (transport === 'foreign_read')
        return allowsOrderOperationsForeignRead(request, { origin }) ? dispatch(request) : null
      const result = await bridge.forward(request)
      return result.action === 'fulfill' ? result.response : null
    }
  }
}

it.each<Transport>(['owned_workbench', 'foreign_read'])(
  'renders confirmed empty activity through the actual %s transport with one exact GET and the original cookie',
  async (transport) => {
    const current = boundary(transport)
    mocks.request.mockImplementation(async (path: string, options: FetchOptions) => {
      const target = new URL(path, origin)
      for (const [key, value] of Object.entries(options.query)) target.searchParams.append(key, String(value))
      const response = await current.forward(
        new TransportRequest(target, {
          method: options.method,
          cache: options.cache,
          headers: { Cookie: originalCookie }
        })
      )
      if (!response) throw new Error('Actual activity transport rejected the component request')
      return response.json()
    })
    const wrapper = await mountSuspended(AdminRecentActivity, {
      props: { enabled: true, pending: false, scopeKey: 'synthetic-identity/session/version' },
      global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } }
    })
    mounted.push(wrapper)
    await flushPromises()
    expect(current.dispatched).toHaveLength(1)
    expect(current.dispatched[0]!.method).toBe('GET')
    expect(current.dispatched[0]!.url).toBe(origin + '/api/admin/activity?limit=5')
    expect(current.dispatched[0]!.headers.get('cookie')).toBe(originalCookie)
    expect(wrapper.get('[data-activity-empty]').text()).toContain('No hay actividad auditada')
    expect(wrapper.find('[data-activity-error]').exists()).toBe(false)
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request.mock.calls[0]![1]).toMatchObject({ method: 'GET', query: { limit: 5 }, retry: 0 })
  }
)

it.each<Transport>(['owned_workbench', 'foreign_read'])(
  'keeps noncanonical activity queries, mutations and external origins outside the actual %s boundary',
  async (transport) => {
    const current = boundary(transport)
    for (const target of [
      origin + '/api/admin/activity?limit=10',
      origin + '/api/admin/activity?limit=5&limit=5',
      origin + '/api/admin/activity?limit=5&actorId=private',
      'https://external.invalid/api/admin/activity?limit=5'
    ])
      expect(await current.forward(new TransportRequest(target, { headers: { Cookie: originalCookie } }))).toBeNull()
    for (const method of ['POST', 'PUT', 'DELETE'])
      expect(
        await current.forward(
          new TransportRequest(origin + '/api/admin/activity?limit=5', {
            method,
            headers: { Cookie: originalCookie }
          })
        )
      ).toBeNull()
    expect(current.dispatched).toHaveLength(0)
  }
)
