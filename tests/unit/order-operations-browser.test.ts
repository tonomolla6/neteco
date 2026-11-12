import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { allowsOrderOperationsForeignRead } from '../../scripts/lib/audit-native-order-operations-browser'
import * as browserAudit from '../../scripts/lib/audit-native-order-operations-browser'

const context = {
  origin: 'https://shop-audit.neteco.test',
  savedViewId: '11111111-1111-4111-8111-111111111111',
  groupId: '22222222-2222-4222-8222-222222222222',
  commandId: '33333333-3333-4333-8333-333333333333'
}
const allowed = (path: string, method = 'GET') =>
  allowsOrderOperationsForeignRead(new Request(context.origin + path, { method }), context)

describe('bounded recent activity reads required by the real admin layout', () => {
  function transport() {
    const dispatch = vi.fn<(request: Request) => Promise<Response>>(async () =>
      Response.json({ source: 'cloudflare', items: [], nextCursor: null })
    )
    const bridge = browserAudit.createWorkbenchBrowserBridge({
      origin: context.origin,
      dispatch,
      bulk: {
        adminCookie: 'neteco-session=synthetic-owner',
        orderIds: [context.groupId],
        readCommittedBulk: async () => {},
        consumeBulkQueue: async () => {}
      }
    })
    return { bridge, dispatch }
  }

  it('forwards the global cart hydration GET before logout and preserves the original request', async () => {
    const { bridge, dispatch } = transport()
    const request = new Request(context.origin + '/api/cart', {
      headers: { cookie: 'neteco-cart=synthetic-own-cart; neteco-session=synthetic-other-actor' }
    })
    expect(allowed('/api/cart')).toBe(true)
    expect((await bridge.forward(request)).action).toBe('fulfill')
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(request)
    expect(bridge.proof.logoutPosts).toBe(0)
  })

  it('does not grant cart commands, broader queries or routes with the hydration read', async () => {
    for (const [path, method] of [
      ['/api/cart?token=private', 'GET'],
      ['/api/cart/items', 'GET'],
      ['/api/cart', 'HEAD'],
      ['/api/cart', 'POST'],
      ['/api/cart', 'DELETE'],
      ['/api/cart', 'PUT']
    ]) {
      const { bridge, dispatch } = transport()
      expect(allowed(path!, method), `${method} ${path}`).toBe(false)
      expect((await bridge.forward(new Request(context.origin + path, { method }))).action).toBe('abort')
      expect(dispatch).not.toHaveBeenCalled()
    }
  })

  it('forwards the exact actual layout logo and favicon in the owned bridge too', async () => {
    for (const path of ['/logo-figura.svg', '/favicon.svg']) {
      for (const method of ['GET', 'HEAD']) {
        const { bridge, dispatch } = transport()
        const request = new Request(context.origin + path, { method })
        expect((await bridge.forward(request)).action).toBe('fulfill')
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(request)
      }
    }
    for (const path of ['/logo-figura.svg/other', '/favicon.svg.bak', '/images/other.png']) {
      const { bridge, dispatch } = transport()
      expect((await bridge.forward(new Request(context.origin + path))).action).toBe('abort')
      expect(dispatch).not.toHaveBeenCalled()
    }
  })

  it('forwards only the layout five-event GET without rewriting the caller session or response', async () => {
    for (const cookie of ['neteco-session=synthetic-owner', 'neteco-session=synthetic-other-actor']) {
      const { bridge, dispatch } = transport()
      const request = new Request(context.origin + '/api/admin/activity?limit=5', { headers: { cookie } })
      expect(allowed('/api/admin/activity?limit=5')).toBe(true)
      const result = await bridge.forward(request)
      expect(result.action).toBe('fulfill')
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(request)
      expect(dispatch.mock.calls[0]![0].headers.get('cookie')).toBe(cookie)
      if (result.action === 'fulfill') expect(result.response).toBe(await dispatch.mock.results[0]!.value)
      expect(bridge.proof).toMatchObject({ bulkPosts: 0, viewPosts: 0, blockedWrites: 0 })
    }
  })

  it('rejects any broader activity query, sibling endpoint, foreign origin or mutation without dispatch', async () => {
    const paths = [
      '/api/admin/activity',
      '/api/admin/activity?limit=6',
      '/api/admin/activity?limit=5&limit=5',
      '/api/admin/activity?limit=5&cursor=other',
      '/api/admin/activity?limit=5&token=private',
      '/api/admin/activity/other?limit=5'
    ]
    for (const path of paths) {
      const { bridge, dispatch } = transport()
      expect(allowed(path), path).toBe(false)
      expect(await bridge.forward(new Request(context.origin + path))).toEqual({
        action: 'abort',
        reason: 'unapproved_request'
      })
      expect(dispatch).not.toHaveBeenCalled()
    }
    for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const { bridge, dispatch } = transport()
      expect(allowed('/api/admin/activity?limit=5', method), method).toBe(false)
      expect(
        (await bridge.forward(new Request(context.origin + '/api/admin/activity?limit=5', { method }))).action
      ).toBe('abort')
      expect(dispatch).not.toHaveBeenCalled()
    }
    const { bridge, dispatch } = transport()
    const foreign = new Request('https://foreign.invalid/api/admin/activity?limit=5')
    expect(allowsOrderOperationsForeignRead(foreign, context)).toBe(false)
    expect(await bridge.forward(foreign)).toEqual({ action: 'abort', reason: 'external' })
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('foreign order read diagnostics disclose only bounded categories', () => {
  it('classifies icon API first, compiled assets, private APIs and pages', () => {
    for (const [path, routeKind] of [
      ['/_icons/lucide.json?icons=warehouse', 'icon_api'],
      ['/_nuxt/app.js?version=private', 'asset'],
      ['/api/admin/orders/' + context.groupId + '?token=private-token', 'private_api'],
      ['/admin/pedidos?email=private%40example.test', 'page'],
      ['/logo-figura.svg', 'page']
    ] as const) {
      expect(browserAudit.foreignOrderReadDiagnostic(new Request(context.origin + path))).toEqual({
        method: 'GET',
        routeKind
      })
    }
  })

  it('preserves GET/HEAD and collapses every mutation method to OTHER', () => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(
        browserAudit.foreignOrderReadDiagnostic(new Request(context.origin + '/api/admin/orders', { method }))
      ).toEqual({ method: method === 'GET' || method === 'HEAD' ? method : 'OTHER', routeKind: 'private_api' })
    }
  })

  it('never emits URLs, identifiers, tokens, cookies, headers or hostile origins', () => {
    for (const [path, routeKind] of [
      ['/_icons/private.json?token=secret-token&email=private%40example.test', 'icon_api'],
      ['/_nuxt/' + context.commandId + '.js?token=secret-token', 'asset'],
      ['/api/admin/orders/' + context.groupId + '?token=secret-token', 'private_api'],
      ['/pedido/' + context.groupId + '?token=secret-token', 'page']
    ] as const) {
      const request = new Request('https://hostile.invalid' + path, {
        method: 'HEAD',
        headers: {
          cookie: 'private-session=secret-cookie',
          origin: 'https://other-hostile.invalid',
          authorization: 'Bearer secret-authorization'
        }
      })
      const diagnostic = browserAudit.foreignOrderReadDiagnostic(request)
      expect(diagnostic).toStrictEqual({ method: 'HEAD', routeKind })
      expect(Object.keys(diagnostic).sort()).toEqual(['method', 'routeKind'])
      expect(JSON.stringify(diagnostic)).not.toMatch(
        /hostile|secret|private@|11111111|22222222|33333333|token|cookie|authorization|https|\//
      )
    }
  })
})

describe('foreign workbench context exact read boundary', () => {
  it('allows the actual admin layout logo and configured favicon without allowing arbitrary public files', async () => {
    const layout = await readFile('app/layouts/admin.vue', 'utf8')
    const config = await readFile('nuxt.config.ts', 'utf8')
    const images = [...layout.matchAll(/<img\b[^>]*\bsrc="(\/[^"?]+)"/g)].map((match) => match[1]!)
    expect(images).toEqual(['/logo-figura.svg'])
    expect(config).toContain("href: '/favicon.svg'")
    for (const path of [
      ...images,
      '/favicon.svg',
      '/favicon.ico',
      '/_nuxt/app.js',
      '/_nuxt/app.css',
      '/_nuxt/font.woff2'
    ]) {
      expect(allowed(path), path).toBe(true)
      expect(allowed(path, 'HEAD'), path).toBe(true)
    }
    for (const path of ['/logo-figura.svg/other', '/favicon.svg.bak', '/private.json', '/images/other.png']) {
      expect(allowed(path), path).toBe(false)
    }
  })

  it('never allows POST or other mutation methods even for permitted assets and private reads', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/logo-figura.svg', '/_nuxt/app.js', '/api/admin/orders', '/api/admin/order-views']) {
        expect(allowed(path, method), `${method} ${path}`).toBe(false)
      }
    }
  })

  it('preserves exact owner-isolation probes and denies unrelated private endpoints and origins', () => {
    for (const path of [
      '/api/_auth/session',
      '/api/admin/capabilities',
      '/api/admin/orders?pagination=cursor',
      '/api/admin/order-views',
      '/api/admin/order-views/' + context.savedViewId,
      '/api/admin/orders/bulk-fulfillment/' + context.groupId,
      '/api/admin/orders/bulk-fulfillment/commands/' + context.commandId + '?payloadHash=' + 'a'.repeat(64)
    ])
      expect(allowed(path), path).toBe(true)
    for (const path of [
      '/api/admin/order-views/44444444-4444-4444-8444-444444444444',
      '/api/admin/orders/bulk-fulfillment/44444444-4444-4444-8444-444444444444',
      '/api/admin/orders/bulk-fulfillment/preview',
      '/api/admin/orders/export.csv',
      '/api/admin/inventory',
      '/api/account',
      '/api/auth/logout',
      '/_icons/lucide.json?icons=contact-round',
      '/_icons/lucide.json?icons=warehouse',
      '/API/admin/orders',
      '/api/admin/orders/anything/detail'
    ])
      expect(allowed(path), path).toBe(false)
    expect(allowsOrderOperationsForeignRead(new Request('https://other.neteco.test/logo-figura.svg'), context)).toBe(
      false
    )
  })
})
