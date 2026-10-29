import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import ts from 'typescript'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION
} from '../support/admin-inventory-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleInventoryCountImportHttp } from '../../workers/catalog/inventory-count-import-http'
import { handleAdminInventoryHttp } from '../../workers/catalog/admin-inventory-http'
import {
  proposeD1InventoryCountImport,
  approveD1InventoryCountImport
} from '../../workers/catalog/inventory-count-import'
import { inventoryCountImportIntentHash, inventoryCountImportPreviewSchema } from '../../shared/inventory-count-import'
import {
  auditNativeInventoryCountImportBrowser,
  createInventoryCountImportBrowserBridge,
  INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS,
  type InventoryCountImportBrowserFixture
} from '../../scripts/lib/audit-native-inventory-count-import-browser'

const connect = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connect,
  REMOTE_BROWSER_NOT_RUN_REASON: 'explicitly not run'
}))
const origin = 'https://shop-audit.neteco.test',
  base = '/api/admin/inventory/count-imports'
const configuration = { password: 'synthetic-count-browser-password-more-than-32', maxAgeSeconds: 3600 }

it('serializes the actual bootstrap callback under tsx keepNames into a browser context without Node helpers', async () => {
  const source = await readFile(
    new URL('../../scripts/lib/audit-native-inventory-count-import-browser.ts', import.meta.url),
    'utf8'
  )
  const ast = ts.createSourceFile('inventory-count-import-browser.ts', source, ts.ScriptTarget.ESNext, true)
  const callbacks: ts.ArrowFunction[] = []
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'evaluate'
    ) {
      const callback = node.arguments[0]
      if (callback && ts.isArrowFunction(callback) && callback.getText(ast).includes("state['$snuxt-session']"))
        callbacks.push(callback)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  expect(callbacks).toHaveLength(1)
  // Match the installed tsx transform. The outer compilation context owns
  // __name; Playwright sends only callback.toString() into the browser realm.
  const compiled = transformSync(
    `const capture = ${callbacks[0]!.getText(ast)}; globalThis.serialized = capture.toString();`,
    {
      loader: 'ts',
      target: 'es2022',
      keepNames: true,
      format: 'iife'
    }
  ).code
  const serialization: { serialized?: string } = {}
  runInNewContext(compiled, serialization, { timeout: 1000 })
  expect(typeof serialization.serialized).toBe('string')
  const result = runInNewContext(
    `(${serialization.serialized})()`,
    {
      window: {
        useNuxtApp: () => ({
          isHydrating: false,
          $config: { public: { serverRuntime: 'cloudflare' } },
          payload: {
            state: {
              '$snuxt-auth-ready': true,
              '$snuxt-session': {
                user: {
                  id: INVENTORY_FIXTURE_ACTOR,
                  email: 'synthetic-private@example.invalid',
                  emailVerified: true,
                  mfaVerified: true
                },
                sessionId: INVENTORY_FIXTURE_SESSION,
                sessionVersion: 1
              },
              '$sadmin-navigation': {
                status: 'ready',
                capabilities: {
                  state: 'ready',
                  identityId: INVENTORY_FIXTURE_ACTOR,
                  sessionId: INVENTORY_FIXTURE_SESSION,
                  sessionVersion: 1
                }
              }
            }
          }
        })
      }
    },
    { timeout: 1000 }
  )
  expect(result).toMatchObject({
    nuxtAppPresent: true,
    hydrating: false,
    runtimeCloudflare: true,
    sessionReady: true,
    loggedIn: true,
    emailVerified: true,
    mfaVerified: true,
    sessionShapeValid: true,
    navigationStatus: 'ready',
    capabilitiesState: 'ready',
    capabilitiesMatchSession: true
  })
  expect(JSON.stringify(result)).not.toContain('synthetic-private')
  expect(JSON.stringify(result)).not.toContain(INVENTORY_FIXTURE_ACTOR)
  expect(JSON.stringify(result)).not.toContain(INVENTORY_FIXTURE_SESSION)
})

let fixture: Awaited<ReturnType<typeof openAdminInventoryFixture>>, prepared: InventoryCountImportBrowserFixture
let dispatch: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>
beforeEach(async () => {
  fixture = await openAdminInventoryFixture()
  fixture.sqlite.exec(
    await readFile(new URL('../../db/d1/migrations/0077_inventory_count_imports.sql', import.meta.url), 'utf8')
  )
  const cookie = async (identityId: string, sessionId: string) =>
    (await issueD1SessionCookie(fixture.database, { identityId, sessionId, sessionVersion: 1 }, configuration))!.split(
      ';'
    )[0]!
  prepared = {
    proposerCookie: await cookie(INVENTORY_FIXTURE_ACTOR, INVENTORY_FIXTURE_SESSION),
    approverCookie: await cookie('10000000-0000-4000-8000-000000000042', '20000000-0000-4000-8000-000000000042'),
    variantLegacyId: 11,
    sku: 'SYNTHETIC-SKU',
    physicalQuantity: 20,
    balanceVersion: 1,
    countedPhysicalQuantity: 21
  }
  dispatch = vi.fn(
    async (request) =>
      (await handleInventoryCountImportHttp(request, {
        database: fixture.database,
        origin,
        sessionCookieConfiguration: configuration,
        edgeLimiter: { limit: async () => ({ success: true }) },
        rateLimitPepper: 'synthetic-count-browser-pepper-more-than-32',
        coordinate: (command) =>
          command.action === 'propose'
            ? proposeD1InventoryCountImport(fixture.database, command.claims, command.input, {
                idempotencyKey: command.idempotencyKey
              })
            : approveD1InventoryCountImport(fixture.database, command.claims, command.targetId!, command.input, {
                idempotencyKey: command.idempotencyKey
              })
      })) ??
      (await handleAdminInventoryHttp(
        request,
        {
          DB: fixture.database,
          AUTH_ENABLED: 'true',
          AUTH_ORIGIN: origin,
          NUXT_SESSION_PASSWORD: configuration.password
        },
        {
          coordinate: async () => {
            throw Error('Unexpected legacy inventory write')
          }
        }
      )) ??
      new Response(null, { status: 404 })
  )
  connect.mockReset()
})
afterEach(() => fixture?.sqlite.close())
function request(path: string, body?: unknown, cookie = prepared.proposerCookie, key = randomUUID(), hash?: string) {
  return new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'CF-Connecting-IP': '192.0.2.177',
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}
const bridge = () =>
  createInventoryCountImportBrowserBridge({ database: fixture.database, dispatch, origin, fixture: prepared })
async function proposal(value: Awaited<ReturnType<typeof bridge>>, cookie = prepared.proposerCookie) {
  const csv = 'sku,countedPhysicalQuantity\n"SYNTHETIC-SKU",21'
  const previewed = await value.forward(request(base + '/preview', { csv }, cookie))
  expect(previewed.action).toBe('fulfill')
  if (previewed.action !== 'fulfill') throw Error('real preview missing')
  expect(previewed.response.status).toBe(200)
  const preview = inventoryCountImportPreviewSchema.parse(await previewed.response.json())
  const body = {
    csv,
    previewHash: preview.previewHash,
    reason: 'Synthetic physical count import reviewed',
    reference: 'SYNTHETIC-BROWSER-INV010'
  }
  const key = randomUUID(),
    hash = await inventoryCountImportIntentHash('propose', null, body)
  const result = await value.forward(request(base, body, cookie, key))
  return { key, hash, result, body }
}
it('NOTRUN has two required IDs but zero scenarios, preparation, SQL, dispatch or connection', async () => {
  const prepare = vi.fn(),
    sql = vi.spyOn(fixture.database, 'prepare'),
    scenario = vi.fn()
  const result = await auditNativeInventoryCountImportBrowser({
    database: fixture.database,
    dispatch,
    origin,
    browserMode: 'not-run',
    prepare,
    scenario
  })
  expect(result).toMatchObject({ scenarios: 0, browserExecuted: false })
  expect(INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS).toHaveLength(2)
  expect(prepare).not.toHaveBeenCalled()
  expect(sql).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
  expect(scenario).not.toHaveBeenCalled()
})
it('loses only a committed proposal and recovers without repost before a different actor approves exactly one balance change', async () => {
  const value = await bridge(),
    proposed = await proposal(value)
  expect(proposed.result).toEqual({ action: 'abort', reason: 'proven_count_import_proposal_response_lost' })
  const command = fixture.sqlite
    .prepare('SELECT response FROM inventory_count_import_commands WHERE idempotency_key=?')
    .get(proposed.key)!
  const receipt = JSON.parse(command.response as string)
  expect(fixture.sqlite.prepare('SELECT physical_quantity,version FROM inventory_balances').get()).toEqual({
    physical_quantity: 20,
    version: 1
  })
  const recovery = await value.forward(
    request(base + '/commands/' + proposed.key, undefined, prepared.proposerCookie, proposed.key, proposed.hash)
  )
  expect(recovery.action).toBe('fulfill')
  await value.forward(request(base + '/' + receipt.importId))
  await value.forward(request(base + '?page=1&perPage=25', undefined, prepared.approverCookie))
  await value.forward(request(base + '/' + receipt.importId, undefined, prepared.approverCookie))
  const approved = await value.forward(
    request(
      base + '/' + receipt.importId + '/approve',
      { expectedVersion: 1, reason: 'Synthetic independent count verification' },
      prepared.approverCookie
    )
  )
  expect(approved.action).toBe('fulfill')
  await value.forward(request(base + '/' + receipt.importId, undefined, prepared.approverCookie))
  expect(await value.assertComplete()).toMatchObject({
    lostResponses: 1,
    proposalPosts: 1,
    approvalPosts: 1,
    recovered: true
  })
  expect(fixture.sqlite.prepare('SELECT physical_quantity,version FROM inventory_balances').get()).toEqual({
    physical_quantity: 21,
    version: 2
  })
})
it('preserves ordinary additional cookies while correlating the exact sealed actor throughout preview, recovery and approval', async () => {
  const proposer = 'neteco-consent=necessary; ' + prepared.proposerCookie + '; neteco-cart-v2=synthetic-cart'
  const approver = 'neteco-cart-v2=synthetic-other-cart; ' + prepared.approverCookie + '; neteco-consent=necessary'
  const value = await bridge()
  const proposed = await proposal(value, proposer)
  expect(proposed.result).toEqual({ action: 'abort', reason: 'proven_count_import_proposal_response_lost' })
  const command = fixture.sqlite
    .prepare('SELECT response FROM inventory_count_import_commands WHERE idempotency_key=?')
    .get(proposed.key)!
  const receipt = JSON.parse(command.response as string)
  await value.forward(request(base + '/commands/' + proposed.key, undefined, proposer, proposed.key, proposed.hash))
  await value.forward(request(base + '/' + receipt.importId, undefined, proposer))
  await value.forward(request(base + '?page=1&perPage=25', undefined, approver))
  await value.forward(request(base + '/' + receipt.importId, undefined, approver))
  const approved = await value.forward(
    request(
      base + '/' + receipt.importId + '/approve',
      {
        expectedVersion: 1,
        reason: 'Synthetic independent count verification'
      },
      approver
    )
  )
  expect(approved.action).toBe('fulfill')
  await value.forward(request(base + '/' + receipt.importId, undefined, approver))
  expect(await value.assertComplete()).toMatchObject({
    lostResponses: 1,
    proposalPosts: 1,
    approvalPosts: 1,
    recovered: true
  })
  const browserRequests = dispatch.mock.calls
    .map(([sent]) => sent)
    .filter((sent) => sent.headers.get('cookie')?.includes('neteco-consent='))
  expect(browserRequests).toHaveLength(8)
  expect(browserRequests.every((sent) => [proposer, approver].includes(sent.headers.get('cookie')!))).toBe(true)
})
it.each(['foreign', 'duplicate-same', 'duplicate-foreign', 'absent'] as const)(
  'rejects %s sealed session cookies before dispatching a preview',
  async (kind) => {
    const value = await bridge()
    dispatch.mockClear()
    const cookie =
      kind === 'foreign'
        ? prepared.approverCookie
        : kind === 'duplicate-same'
          ? prepared.proposerCookie + '; ' + prepared.proposerCookie
          : kind === 'duplicate-foreign'
            ? prepared.proposerCookie + '; ' + prepared.approverCookie
            : 'neteco-consent=necessary; neteco-cart-v2=synthetic-cart'
    await expect(value.forward(request(base + '/preview', { csv: value.csv }, cookie))).rejects.toMatchObject({
      stage: 'forward'
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(value.state().previewPosts).toBe(0)
    expect(value.state().proposalPosts).toBe(0)
  }
)
it('does not classify a real non-201 response as a committed lost response', async () => {
  const value = await bridge()
  fixture.sqlite.exec(
    "CREATE TRIGGER synthetic_abort_count BEFORE INSERT ON inventory_count_import_commands BEGIN SELECT RAISE(ABORT,'synthetic'); END"
  )
  const proposed = await proposal(value)
  expect(proposed.result.action).toBe('fulfill')
  if (proposed.result.action === 'fulfill') expect(proposed.result.response.status).toBe(503)
  expect(value.state().lostResponses).toBe(0)
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM inventory_count_import_commands').get()?.n).toBe(0)
})
it('rejects wrong receipt correlation after real commit rather than manufacturing proof of response loss', async () => {
  const actual = dispatch
  dispatch = vi.fn(async (req) => {
    const response = await actual(req)
    if (req.method === 'POST' && new URL(req.url).pathname === base && response.status === 201) {
      const data = (await response.json()) as Record<string, unknown>
      return new Response(JSON.stringify({ ...data, commandId: randomUUID() }), {
        status: 201,
        headers: response.headers
      })
    }
    return response
  })
  const value = await bridge()
  await expect(proposal(value)).rejects.toThrow()
  expect(value.state().lostResponses).toBe(0)
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM inventory_count_import_commands').get()?.n).toBe(1)
})
it('blocks extra writes and external destinations before dispatch', async () => {
  const value = await bridge()
  dispatch.mockClear()
  expect((await value.forward(request('/api/admin/inventory/variants/11/adjust', { quantity: 20 }))).action).toBe(
    'abort'
  )
  expect((await value.forward(new Request('https://example.invalid/'))).action).toBe('abort')
  expect(dispatch).not.toHaveBeenCalled()
})
it('reports the preparation stage and viewport without retaining raw fixture errors or secrets', async () => {
  const close = vi.fn(async () => {}),
    newContext = vi.fn(),
    scenario = vi.fn()
  connect.mockResolvedValueOnce({ close, newContext })
  const error = await auditNativeInventoryCountImportBrowser({
    database: fixture.database,
    dispatch,
    origin,
    browserMode: 'required',
    scenario,
    prepare: async () => {
      throw new Error('synthetic-private-token-and-recipient@example.invalid')
    }
  }).catch((error: unknown) => error)
  expect(error).toMatchObject({ name: 'InventoryCountImportBrowserError', stage: 'prepare', viewport: 'desktop' })
  expect(JSON.stringify(error)).not.toContain('synthetic-private')
  expect((error as Error).message).not.toContain('recipient')
  expect(newContext).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
  expect(scenario).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})
it('captures proposer navigation failure at its actual step with safe counters and closes the owned context', async () => {
  const close = vi.fn(async () => {}),
    contextClose = vi.fn(async () => {}),
    scenario = vi.fn()
  const page = { on: vi.fn(), goto: vi.fn().mockRejectedValue(new Error('synthetic-cookie-and-private-url')) }
  const context = { addCookies: vi.fn(), route: vi.fn(), newPage: vi.fn(async () => page), close: contextClose }
  connect.mockResolvedValueOnce({ close, newContext: vi.fn(async () => context) })
  const error = await auditNativeInventoryCountImportBrowser({
    database: fixture.database,
    dispatch,
    origin,
    browserMode: 'required',
    scenario,
    prepare: async () => prepared
  }).catch((error: unknown) => error)
  expect(error).toMatchObject({
    name: 'InventoryCountImportBrowserError',
    stage: 'proposer_navigation',
    viewport: 'desktop',
    safeDiagnostic: {
      stage: 'proposer_navigation',
      viewport: 'desktop',
      transportFailure: false,
      pageErrors: 0,
      previewPosts: 0,
      proposalPosts: 0,
      approvalPosts: 0,
      lostResponses: 0,
      receiptGets: 0
    }
  })
  expect(JSON.stringify(error)).not.toContain('synthetic-cookie')
  expect((error as Error).message).not.toContain('private-url')
  expect(scenario).not.toHaveBeenCalled()
  expect(contextClose).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})
it('distinguishes a completed document navigation from a missing panel without exposing redirected URL secrets', async () => {
  const close = vi.fn(async () => {}),
    contextClose = vi.fn(async () => {})
  const page = {
    on: vi.fn(),
    goto: vi.fn(async () => ({ status: () => 403 })),
    url: () => origin + '/login?redirect=synthetic-private-value',
    getByRole: vi.fn((_role: string, options: { name: string }) => {
      if (options.name === 'Rechazar opcionales') return { isVisible: async () => false }
      throw new Error('synthetic-private-panel-error')
    })
  }
  const context = { addCookies: vi.fn(), route: vi.fn(), newPage: vi.fn(async () => page), close: contextClose }
  connect.mockResolvedValueOnce({ close, newContext: vi.fn(async () => context) })
  const error = await auditNativeInventoryCountImportBrowser({
    database: fixture.database,
    dispatch,
    origin,
    browserMode: 'required',
    prepare: async () => prepared
  }).catch((error: unknown) => error)
  expect(error).toMatchObject({
    stage: 'proposer_panel',
    viewport: 'desktop',
    safeDiagnostic: {
      stage: 'proposer_panel',
      documentStatus: 403,
      routeKind: 'login',
      panelCount: null,
      sessionStatus: null,
      capabilitiesStatus: null
    }
  })
  expect(JSON.stringify(error)).not.toContain('synthetic-private')
  expect(contextClose).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})
it('captures bootstrap transport and live Nuxt authority as counters, classifications and booleans only', async () => {
  const listeners = new Map<string, (value: unknown) => void>()
  const script = { resourceType: () => 'script' }
  const close = vi.fn(async () => {})
  const page = {
    on: vi.fn((name: string, listener: (value: unknown) => void) => {
      listeners.set(name, listener)
    }),
    goto: vi.fn(async () => {
      for (let index = 0; index < 3; index++) listeners.get('request')?.(script)
      listeners.get('response')?.({
        request: () => script,
        status: () => 200,
        headers: () => ({ 'content-type': 'text/javascript' })
      })
      listeners.get('response')?.({
        request: () => script,
        status: () => 404,
        headers: () => ({ 'content-type': 'text/html' })
      })
      listeners.get('requestfailed')?.(script)
      for (const text of [
        'Content Security Policy synthetic-private',
        'MIME type text/html synthetic-private',
        'Failed to fetch dynamically imported module synthetic-private',
        'Hydration mismatch synthetic-private',
        'synthetic-private other error'
      ])
        listeners.get('console')?.({ type: () => 'error', text: () => text })
      return { status: () => 200 }
    }),
    url: () => origin + '/admin/inventario',
    evaluate: vi.fn(async (capture: () => unknown) => capture()),
    getByRole: vi.fn((_role: string, options: { name: string }) => {
      if (options.name === 'Rechazar opcionales') return { isVisible: async () => false }
      throw new Error('synthetic-private-panel-error')
    })
  }
  vi.stubGlobal('window', {
    useNuxtApp: () => ({
      isHydrating: false,
      $config: { public: { serverRuntime: 'cloudflare' } },
      payload: {
        state: {
          '$snuxt-auth-ready': true,
          '$snuxt-session': {
            user: {
              id: INVENTORY_FIXTURE_ACTOR,
              email: 'synthetic-private@example.invalid',
              emailVerified: true,
              mfaVerified: true
            },
            sessionId: INVENTORY_FIXTURE_SESSION,
            sessionVersion: 1
          },
          '$sadmin-navigation': {
            status: 'ready',
            capabilities: {
              state: 'ready',
              identityId: INVENTORY_FIXTURE_ACTOR,
              sessionId: INVENTORY_FIXTURE_SESSION,
              sessionVersion: 1
            }
          }
        }
      }
    })
  })
  try {
    const context = { addCookies: vi.fn(), route: vi.fn(), newPage: vi.fn(async () => page), close }
    connect.mockResolvedValueOnce({ close, newContext: vi.fn(async () => context) })
    const error = await auditNativeInventoryCountImportBrowser({
      database: fixture.database,
      dispatch,
      origin,
      browserMode: 'required',
      prepare: async () => prepared
    }).catch((error: unknown) => error)
    expect(error).toMatchObject({
      safeDiagnostic: {
        bootstrap: {
          scriptsRequested: 3,
          scriptResponses200: 1,
          scriptResponsesNon200: 1,
          scriptMimeNonJs: 1,
          scriptsFailed: 1,
          consoleErrors: { csp: 1, script_mime: 1, module_load: 1, hydration: 1, other: 1 },
          nuxtAppPresent: true,
          hydrating: false,
          runtimeCloudflare: true,
          sessionReady: true,
          loggedIn: true,
          emailVerified: true,
          mfaVerified: true,
          sessionShapeValid: true,
          navigationStatus: 'ready',
          capabilitiesState: 'ready',
          capabilitiesMatchSession: true
        }
      }
    })
    expect(JSON.stringify(error)).not.toContain('synthetic-private')
    expect(page.evaluate).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledTimes(2)
  } finally {
    vi.unstubAllGlobals()
  }
})
