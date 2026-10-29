import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import { z } from 'zod'
import { adminInventoryVariantSchema } from '../../shared/inventory-commands'
import {
  inventoryCountImportPreviewSchema,
  inventoryCountImportProposalInputSchema,
  inventoryCountImportApprovalInputSchema,
  inventoryCountImportReceiptSchema,
  inventoryCountImportSnapshotSchema,
  inventoryCountImportListSchema,
  inventoryCountImportCommandSchema,
  inventoryCountImportIntentHash,
  type InventoryCountImportReceipt,
  type InventoryCountImportPreview
} from '../../shared/inventory-count-import'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'
import { sealedSessionCookie } from './audit-browser-session-cookie'

export const INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS = [
  'native_inventory_count_import_compiled_propose_recovery_second_actor_approval_desktop',
  'native_inventory_count_import_compiled_propose_recovery_second_actor_approval_mobile'
] as const
export interface InventoryCountImportBrowserFixture {
  proposerCookie: string
  approverCookie: string
  variantLegacyId: number
  sku: string
  physicalQuantity: number
  balanceVersion: number
  countedPhysicalQuantity: number
}
export interface NativeInventoryCountImportBrowserInput {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  browserMode?: 'required' | 'not-run'
  prepare: (viewport: 'desktop' | 'mobile') => Promise<InventoryCountImportBrowserFixture>
  scenario?: (name: string) => void
}
export type InventoryCountImportBrowserBridgeInput = Omit<
  NativeInventoryCountImportBrowserInput,
  'prepare' | 'browserMode' | 'scenario'
> & { fixture: InventoryCountImportBrowserFixture }
type ForwardResult = { action: 'abort'; reason: string } | { action: 'fulfill'; response: Response }
export type InventoryCountImportBrowserStage =
  | 'fixture'
  | 'forward'
  | 'completion'
  | 'compiled_page'
  | 'prepare'
  | 'proposer_navigation'
  | 'proposer_panel'
  | 'proposer_preview'
  | 'proposer_review'
  | 'proposer_submit'
  | 'proposer_recovery'
  | 'approver_navigation'
  | 'approver_panel'
  | 'approver_open'
  | 'approver_review'
  | 'approver_submit'
  | 'domain_completion'
export interface InventoryCountImportBrowserDiagnostic {
  stage: InventoryCountImportBrowserStage
  viewport: 'desktop' | 'mobile' | null
  transportFailure: boolean
  pageErrors: number
  previewPosts: number
  proposalPosts: number
  approvalPosts: number
  lostResponses: number
  receiptGets: number
  documentStatus: number | null
  routeKind: 'inventory' | 'login' | 'admin' | 'other'
  panelCount: number | null
  sessionStatus: number | null
  capabilitiesStatus: number | null
  bootstrap: InventoryCountImportBootstrapDiagnostic
}
export interface InventoryCountImportBootstrapDiagnostic {
  scriptsRequested: number
  scriptResponses200: number
  scriptResponsesNon200: number
  scriptMimeNonJs: number
  scriptsFailed: number
  consoleErrors: Record<'csp' | 'script_mime' | 'module_load' | 'hydration' | 'other', number>
  nuxtAppPresent: boolean | null
  hydrating: boolean | null
  runtimeCloudflare: boolean | null
  sessionReady: boolean | null
  loggedIn: boolean | null
  emailVerified: boolean | null
  mfaVerified: boolean | null
  sessionShapeValid: boolean | null
  navigationStatus: 'idle' | 'loading' | 'ready' | 'error' | 'unauthenticated' | null
  capabilitiesState: 'ready' | 'forbidden' | 'email_unverified' | 'mfa_required' | null
  capabilitiesMatchSession: boolean | null
}
function emptyBootstrap(): InventoryCountImportBootstrapDiagnostic {
  return {
    scriptsRequested: 0,
    scriptResponses200: 0,
    scriptResponsesNon200: 0,
    scriptMimeNonJs: 0,
    scriptsFailed: 0,
    consoleErrors: { csp: 0, script_mime: 0, module_load: 0, hydration: 0, other: 0 },
    nuxtAppPresent: null,
    hydrating: null,
    runtimeCloudflare: null,
    sessionReady: null,
    loggedIn: null,
    emailVerified: null,
    mfaVerified: null,
    sessionShapeValid: null,
    navigationStatus: null,
    capabilitiesState: null,
    capabilitiesMatchSession: null
  }
}
export class InventoryCountImportBrowserError extends Error {
  readonly safeDiagnostic: InventoryCountImportBrowserDiagnostic
  constructor(
    readonly stage: InventoryCountImportBrowserStage,
    readonly viewport: 'desktop' | 'mobile' | null = null,
    diagnostic: Partial<Omit<InventoryCountImportBrowserDiagnostic, 'stage' | 'viewport'>> = {}
  ) {
    super('Isolated compiled inventory count import check failed')
    this.name = 'InventoryCountImportBrowserError'
    const httpStatus = (value: number | null | undefined) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
    this.safeDiagnostic = {
      stage,
      viewport,
      transportFailure: diagnostic.transportFailure === true,
      pageErrors: diagnostic.pageErrors ?? 0,
      previewPosts: diagnostic.previewPosts ?? 0,
      proposalPosts: diagnostic.proposalPosts ?? 0,
      approvalPosts: diagnostic.approvalPosts ?? 0,
      lostResponses: diagnostic.lostResponses ?? 0,
      receiptGets: diagnostic.receiptGets ?? 0,
      documentStatus: httpStatus(diagnostic.documentStatus),
      routeKind: diagnostic.routeKind ?? 'other',
      panelCount: diagnostic.panelCount ?? null,
      sessionStatus: httpStatus(diagnostic.sessionStatus),
      capabilitiesStatus: httpStatus(diagnostic.capabilitiesStatus),
      bootstrap: diagnostic.bootstrap ?? emptyBootstrap()
    }
  }
}
const base = '/api/admin/inventory/count-imports'
function isolated(origin: string) {
  assert.equal(origin, 'https://shop-audit.neteco.test')
}
function cookieValue(cookie: string) {
  assert(cookie.length <= 16384)
  const match = /^neteco-session=([^;\r\n]+)$/.exec(cookie)
  assert(match, 'Isolated signed session required')
  return match[1]!
}
async function privateJson(response: Response, status = 200) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('vary'), 'Cookie')
  assert(!response.headers.has('set-cookie'))
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/i)
  const bytes = new Uint8Array(await response.clone().arrayBuffer())
  assert(bytes.length > 0 && bytes.length <= 256 * 1024)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}
async function rows(database: D1Database, sql: string, ...parameters: (string | number)[]) {
  const result = await database
    .prepare(sql)
    .bind(...parameters)
    .all<Record<string, unknown>>()
  assert(result.success && result.results.length <= 1000, 'Bounded readonly evidence required')
  if (result.meta?.rows_written !== undefined) assert.equal(result.meta.rows_written, 0)
  return result.results.map((row) => Object.fromEntries(Object.entries(row)))
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Real HTTP/D1 only. Business writes: one proposal, one independent approval.
 * Optional-consent rejection may DELETE its own analytics session. Bounded
 * snapshots are limited evidence, not a claim about every SQL rows_written. */
export async function createInventoryCountImportBrowserBridge(input: InventoryCountImportBrowserBridgeInput) {
  isolated(input.origin)
  const fixture = z
    .object({
      proposerCookie: z.string().min(1),
      approverCookie: z.string().min(1),
      variantLegacyId: z.number().int().positive().safe(),
      sku: z.string().min(1).max(120),
      physicalQuantity: z.number().int().nonnegative().safe(),
      balanceVersion: z.number().int().positive().safe(),
      countedPhysicalQuantity: z.number().int().nonnegative().safe()
    })
    .strict()
    .parse(input.fixture)
  cookieValue(fixture.proposerCookie)
  cookieValue(fixture.approverCookie)
  assert.notEqual(fixture.proposerCookie, fixture.approverCookie)
  assert.equal(fixture.countedPhysicalQuantity, fixture.physicalQuantity + 1)
  const csv =
    'sku,countedPhysicalQuantity\n"' + fixture.sku.replaceAll('"', '""') + '",' + fixture.countedPhysicalQuantity
  const get = (path: string, cookie = fixture.proposerCookie, hash?: string) =>
    input.dispatch(
      new Request(input.origin + path, {
        headers: {
          Cookie: cookie,
          Origin: input.origin,
          'CF-Connecting-IP': '192.0.2.177',
          ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
        }
      })
    )
  const variant = async () =>
    adminInventoryVariantSchema.parse(
      await privateJson(await get('/api/admin/inventory/variants/' + fixture.variantLegacyId))
    )
  const inventory = async () => ({
    balances: await rows(input.database, 'SELECT * FROM inventory_balances ORDER BY variant_id,location_id LIMIT 1001'),
    movements: await rows(input.database, 'SELECT * FROM inventory_movements ORDER BY id LIMIT 1001'),
    reservations: await rows(input.database, 'SELECT * FROM inventory_reservations ORDER BY id LIMIT 1001'),
    reservationLines: await rows(
      input.database,
      'SELECT * FROM inventory_reservation_lines ORDER BY reservation_id,variant_id,location_id LIMIT 1001'
    )
  })
  const economy = async () =>
    digest(
      await Promise.all(
        [
          'orders',
          'order_lines',
          'payment_intents',
          'payment_commands',
          'financial_commands',
          'refund_contracts',
          'refund_allocations',
          'refund_receipts'
        ].map((table) => rows(input.database, `SELECT * FROM ${table} ORDER BY 1,2 LIMIT 1001`))
      )
    )
  let initial: Awaited<ReturnType<typeof variant>>,
    before: Awaited<ReturnType<typeof inventory>>,
    economicBefore: string
  try {
    initial = await variant()
    assert.equal(initial.variant.id, fixture.variantLegacyId)
    assert.equal(initial.variant.sku, fixture.sku)
    assert.equal(initial.balance.physicalQuantity, fixture.physicalQuantity)
    assert.equal(initial.balance.version, fixture.balanceVersion)
    before = await inventory()
    economicBefore = await economy()
  } catch {
    throw new InventoryCountImportBrowserError('fixture')
  }
  const counters = {
    previewPosts: 0,
    proposalPosts: 0,
    approvalPosts: 0,
    lostResponses: 0,
    receiptGets: 0,
    recovered: false,
    approverListed: false,
    approverOpened: false,
    approvalFresh: false,
    importId: null as string | null,
    blockedWrites: 0,
    blockedExternal: 0
  }
  let preview: InventoryCountImportPreview | null = null,
    proposal: InventoryCountImportReceipt | null = null,
    approval: InventoryCountImportReceipt | null = null,
    proposerActor: string | null = null,
    approverActor: string | null = null,
    manualReceipt = false
  const abort = (reason: string): ForwardResult => ({ action: 'abort', reason })
  async function unchanged() {
    assert.deepEqual(await inventory(), before)
    assert.equal(await economy(), economicBefore)
  }
  function matching(raw: unknown, key: string, hash: string, action: 'propose' | 'approve') {
    const receipt = inventoryCountImportReceiptSchema.parse(raw)
    assert.equal(receipt.commandId, key)
    assert.equal(receipt.payloadHash, hash)
    assert.equal(receipt.action, action)
    assert.equal(receipt.expectedVersion, action === 'propose' ? 0 : 1)
    assert.equal(receipt.version, action === 'propose' ? 1 : 2)
    assert.equal(receipt.rowCount, 1)
    assert.equal(receipt.changedCount, 1)
    assert.equal(receipt.inventoryEffect, action === 'propose' ? 'none' : 'physical_adjustment')
    assert.equal(receipt.economicEffect, 'none')
    if (action === 'approve') assert.equal(receipt.importId, proposal?.importId)
    return receipt
  }
  async function commandProof(receipt: InventoryCountImportReceipt) {
    const evidence = await rows(
      input.database,
      `SELECT c.actor_id,c.action,c.import_id,c.payload_hash,c.response,a.response AS audit_response,a.actor_id AS audit_actor,a.payload_hash AS audit_hash
      FROM inventory_count_import_commands c JOIN inventory_count_import_audit a ON a.command_id=c.id
      WHERE c.idempotency_key=? AND c.import_id=? LIMIT 3`,
      receipt.commandId,
      receipt.importId
    )
    assert.equal(evidence.length, 1)
    const row = evidence[0]!
    assert.equal(row.action, receipt.action)
    assert.equal(row.import_id, receipt.importId)
    assert.equal(row.payload_hash, receipt.payloadHash)
    assert.equal(row.audit_hash, receipt.payloadHash)
    assert.equal(row.actor_id, row.audit_actor)
    assert.deepEqual(inventoryCountImportReceiptSchema.parse(JSON.parse(String(row.response))), receipt)
    assert.deepEqual(inventoryCountImportReceiptSchema.parse(JSON.parse(String(row.audit_response))), receipt)
    return z.string().uuid().parse(row.actor_id)
  }
  async function fresh(cookie: string, approved: boolean, raw?: unknown) {
    assert(proposal && proposerActor)
    const data = inventoryCountImportSnapshotSchema.parse(
      raw ?? (await privateJson(await get(base + '/' + proposal.importId, cookie)))
    )
    assert.equal(data.importId, proposal.importId)
    assert.equal(data.version, approved ? 2 : 1)
    assert.equal(data.status, approved ? 'approved' : 'proposed')
    assert.equal(data.proposedBy, proposerActor)
    assert.equal(data.approvedBy, approved ? approverActor : null)
    assert.equal(data.rows.length, 1)
    const row = data.rows[0]!
    assert.equal(row.variantId, fixture.variantLegacyId)
    assert.equal(row.sku, fixture.sku)
    assert.equal(row.expectedBalanceVersion, fixture.balanceVersion)
    assert.equal(row.physicalQuantity, fixture.physicalQuantity)
    assert.equal(row.countedPhysicalQuantity, fixture.countedPhysicalQuantity)
    assert.equal(row.physicalDelta, 1)
    assert.equal(row.currentBalanceVersion, fixture.balanceVersion + (approved ? 1 : 0))
    assert.equal(row.currentPhysicalQuantity, approved ? fixture.countedPhysicalQuantity : fixture.physicalQuantity)
    assert.equal(row.error, null)
    if (!approved) assert.equal(row.stale, false)
    if (!approved && sealedSessionCookie(cookie) === fixture.approverCookie) assert(data.capabilities.approve)
    return data
  }
  async function approvedDomain() {
    assert(approval && proposal)
    const after = await inventory(),
      current = await variant()
    assert.equal(current.balance.physicalQuantity, fixture.countedPhysicalQuantity)
    assert.equal(current.balance.version, fixture.balanceVersion + 1)
    assert.deepEqual(
      {
        ...current.balance,
        physicalQuantity: initial.balance.physicalQuantity,
        sellableQuantity: initial.balance.sellableQuantity,
        version: initial.balance.version
      },
      initial.balance
    )
    assert.deepEqual(after.reservations, before.reservations)
    assert.deepEqual(after.reservationLines, before.reservationLines)
    assert.equal(after.balances.length, before.balances.length)
    const selected = (row: Record<string, unknown>) =>
      row.variant_id === initial.variant.uuid && row.location_id === initial.warehouse.id
    assert.equal(after.balances.filter(selected).length, 1)
    assert.deepEqual(
      after.balances.filter((row) => !selected(row)),
      before.balances.filter((row) => !selected(row))
    )
    const original = before.balances.find(selected)!,
      changed = after.balances.find(selected)!
    assert.equal(changed.physical_quantity, fixture.countedPhysicalQuantity)
    assert.equal(changed.version, fixture.balanceVersion + 1)
    assert.deepEqual(
      {
        ...changed,
        physical_quantity: original.physical_quantity,
        version: original.version,
        updated_at: original.updated_at
      },
      original
    )
    const oldIds = new Set(before.movements.map((row) => row.id))
    assert.deepEqual(
      after.movements.filter((row) => oldIds.has(row.id)),
      before.movements
    )
    const added = after.movements.filter((row) => !oldIds.has(row.id))
    assert.equal(added.length, 1)
    assert.equal(added[0]!.variant_id, initial.variant.uuid)
    assert.equal(added[0]!.location_id, initial.warehouse.id)
    assert.equal(added[0]!.physical_delta, 1)
    assert.equal(added[0]!.reserved_delta, 0)
    assert.equal(added[0]!.reference_type, 'inventory_count_import')
    assert.equal(added[0]!.correlation_id, proposal.importId)
    assert.equal(await economy(), economicBefore)
    const commands = await rows(
      input.database,
      'SELECT id,action FROM inventory_count_import_commands WHERE import_id=? ORDER BY action LIMIT 3',
      proposal.importId
    )
    assert.deepEqual(
      commands.map((row) => row.action),
      ['approve', 'propose']
    )
    assert.equal(added[0]!.reference_id, commands[0]!.id)
  }
  async function forward(request: Request): Promise<ForwardResult> {
    try {
      const url = new URL(request.url),
        path = url.pathname,
        cookie = request.headers.get('cookie'),
        sessionCookie = sealedSessionCookie(cookie)
      if (url.origin !== input.origin) {
        counters.blockedExternal++
        return abort('external_request')
      }
      const read = request.method === 'GET' || request.method === 'HEAD'
      const consent = request.method === 'DELETE' && path === '/api/analytics/session' && !url.search
      const isPreview = request.method === 'POST' && path === base + '/preview'
      const isProposal = request.method === 'POST' && path === base
      const isApproval = request.method === 'POST' && proposal && path === base + '/' + proposal.importId + '/approve'
      if (!read && !consent && !isPreview && !isProposal && !isApproval) {
        counters.blockedWrites++
        return abort('unapproved_write')
      }
      if (isPreview || isProposal || isApproval) {
        const text = await request.clone().text(),
          key = request.headers.get('idempotency-key')
        assert(!url.search && Buffer.byteLength(text) <= 128 * 1024)
        assert.equal(request.headers.get('origin'), input.origin)
        assert.match(request.headers.get('content-type') ?? '', /^application\/json(?:\s*;\s*charset=utf-8)?$/i)
        assert.equal(sessionCookie, isApproval ? fixture.approverCookie : fixture.proposerCookie)
        const raw: unknown = JSON.parse(text)
        if (isPreview) {
          assert.equal(counters.previewPosts++, 0)
          assert.deepEqual(raw, { csv })
          const response = await input.dispatch(request)
          if (response.status === 200) {
            preview = inventoryCountImportPreviewSchema.parse(await privateJson(response))
            assert(preview.canPropose && preview.rows.length === 1)
            assert.deepEqual(preview.rows[0], {
              rowNumber: 2,
              sku: fixture.sku,
              countedPhysicalQuantity: fixture.countedPhysicalQuantity,
              variantId: fixture.variantLegacyId,
              expectedBalanceVersion: fixture.balanceVersion,
              physicalQuantity: fixture.physicalQuantity,
              physicalDelta: 1,
              error: null
            })
            await unchanged()
          }
          return { action: 'fulfill', response }
        }
        z.string().uuid().parse(key)
        if (isProposal) {
          assert(preview)
          assert.equal(counters.proposalPosts++, 0)
          const body = inventoryCountImportProposalInputSchema.parse(raw)
          assert.equal(body.csv, csv)
          assert.equal(body.previewHash, preview.previewHash)
          const hash = await inventoryCountImportIntentHash('propose', null, body)
          await unchanged()
          const response = await input.dispatch(request)
          if (response.status !== 201) return { action: 'fulfill', response }
          proposal = matching(await privateJson(response, 201), key!, hash, 'propose')
          proposerActor = await commandProof(proposal)
          const recovered = inventoryCountImportCommandSchema.parse(
            await privateJson(await get(base + '/commands/' + key, fixture.proposerCookie, hash))
          )
          assert.equal(recovered.outcome, 'applied')
          if (recovered.outcome === 'applied') assert.deepEqual(recovered.receipt, proposal)
          await fresh(fixture.proposerCookie, false)
          await unchanged()
          counters.importId = proposal.importId
          counters.lostResponses++
          return abort('proven_count_import_proposal_response_lost')
        }
        assert(proposal && counters.recovered && counters.approverListed && counters.approverOpened)
        assert.equal(counters.approvalPosts++, 0)
        const body = inventoryCountImportApprovalInputSchema.parse(raw)
        assert.equal(body.expectedVersion, 1)
        const hash = await inventoryCountImportIntentHash('approve', proposal.importId, body)
        await unchanged()
        const response = await input.dispatch(request)
        if (response.status === 201) {
          approval = matching(await privateJson(response, 201), key!, hash, 'approve')
          approverActor = await commandProof(approval)
          assert.notEqual(approverActor, proposerActor)
          await fresh(fixture.approverCookie, true)
          await approvedDomain()
        }
        return { action: 'fulfill', response }
      }
      const response = await input.dispatch(request)
      if (read && proposal && response.status === 200) {
        if (path === base + '/commands/' + proposal.commandId) {
          assert.equal(sessionCookie, fixture.proposerCookie)
          assert.equal(request.headers.get('X-Neteco-Command-Payload-Hash'), proposal.payloadHash)
          const value = inventoryCountImportCommandSchema.parse(await privateJson(response))
          assert.equal(value.outcome, 'applied')
          if (value.outcome === 'applied') assert.deepEqual(value.receipt, proposal)
          counters.receiptGets++
          manualReceipt = true
        }
        if (path === base && sessionCookie === fixture.approverCookie) {
          const list = inventoryCountImportListSchema.parse(await privateJson(response))
          assert(list.items.some((item) => item.importId === proposal!.importId && item.status === 'proposed'))
          counters.approverListed = true
        }
        if (
          path === base + '/' + proposal.importId &&
          (sessionCookie === fixture.proposerCookie || sessionCookie === fixture.approverCookie)
        ) {
          await fresh(cookie!, !!approval, await privateJson(response))
          if (!approval && sessionCookie === fixture.proposerCookie && manualReceipt) counters.recovered = true
          if (!approval && sessionCookie === fixture.approverCookie) counters.approverOpened = true
          if (approval && sessionCookie === fixture.approverCookie) counters.approvalFresh = true
        }
      }
      return { action: 'fulfill', response }
    } catch {
      throw new InventoryCountImportBrowserError('forward')
    }
  }
  async function assertComplete() {
    try {
      assert.equal(counters.previewPosts, 1)
      assert.equal(counters.proposalPosts, 1)
      assert.equal(counters.approvalPosts, 1)
      assert.equal(counters.lostResponses, 1)
      assert.equal(counters.receiptGets, 1)
      assert(
        counters.recovered && counters.approverListed && counters.approverOpened && counters.approvalFresh && approval
      )
      assert.equal(counters.blockedWrites, 0)
      assert.equal(counters.blockedExternal, 0)
      await approvedDomain()
      await fresh(fixture.approverCookie, true)
      return { ...counters }
    } catch {
      throw new InventoryCountImportBrowserError('completion')
    }
  }
  return { forward, state: () => ({ ...counters }), assertComplete, csv }
}
export async function auditNativeInventoryCountImportBrowser(input: NativeInventoryCountImportBrowserInput) {
  isolated(input.origin)
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  if (input.browserMode === 'not-run')
    return { scenarios: 0, browserExecuted: false, reason: REMOTE_BROWSER_NOT_RUN_REASON, viewports: [] }
  const browser = await connectRemoteTestBrowser(chromium),
    contexts: BrowserContext[] = [],
    viewports = ['desktop', 'mobile'] as const
  let scenarios = 0
  try {
    for (const [index, viewport] of viewports.entries()) {
      let stage: InventoryCountImportBrowserStage = 'prepare'
      let transportFailure = false,
        pageErrors = 0
      let currentBridge: Awaited<ReturnType<typeof createInventoryCountImportBrowserBridge>> | null = null
      const observation: Pick<
        InventoryCountImportBrowserDiagnostic,
        'documentStatus' | 'routeKind' | 'panelCount' | 'sessionStatus' | 'capabilitiesStatus'
      > = {
        documentStatus: null,
        routeKind: 'other',
        panelCount: null,
        sessionStatus: null,
        capabilitiesStatus: null
      }
      const current: { page: Page | null } = { page: null }
      let bootstrap = emptyBootstrap()
      try {
        const fixture = await input.prepare(viewport)
        stage = 'fixture'
        const bridge = await createInventoryCountImportBrowserBridge({ ...input, fixture })
        currentBridge = bridge
        const context = async (cookie: string) => {
          Object.assign(observation, {
            documentStatus: null,
            routeKind: 'other',
            panelCount: null,
            sessionStatus: null,
            capabilitiesStatus: null
          })
          current.page = null
          const contextBootstrap = emptyBootstrap()
          bootstrap = contextBootstrap
          const created = await browser.newContext({
            locale: 'es-ES',
            timezoneId: 'Europe/Madrid',
            serviceWorkers: 'block',
            viewport: viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 }
          })
          contexts.push(created)
          await created.addCookies([
            {
              name: 'neteco-session',
              value: cookieValue(cookie),
              url: input.origin,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax'
            }
          ])
          await created.route('**/*', async (route) => {
            try {
              const incoming = route.request(),
                headers = await incoming.allHeaders(),
                payload = incoming.postDataBuffer()
              headers['cf-connecting-ip'] = '192.0.2.177'
              headers['accept-encoding'] = 'identity'
              const result = await bridge.forward(
                new Request(incoming.url(), {
                  method: incoming.method(),
                  headers,
                  redirect: 'manual',
                  ...(payload ? { body: Uint8Array.from(payload).buffer } : {})
                })
              )
              if (result.action === 'abort') {
                if (result.reason !== 'proven_count_import_proposal_response_lost') transportFailure = true
                await route.abort('failed')
              } else {
                if (incoming.method() === 'GET') {
                  const path = new URL(incoming.url()).pathname
                  if (path === '/api/_auth/session') observation.sessionStatus = result.response.status
                  if (path === '/api/admin/capabilities') observation.capabilitiesStatus = result.response.status
                }
                const forwarded = Object.fromEntries(result.response.headers)
                delete forwarded['content-length']
                delete forwarded['content-encoding']
                await route.fulfill({
                  status: result.response.status,
                  headers: forwarded,
                  body: Buffer.from(await result.response.arrayBuffer())
                })
              }
            } catch {
              transportFailure = true
              await route.abort('failed')
            }
          })
          const page = await created.newPage()
          current.page = page
          page.on('pageerror', () => {
            pageErrors++
          })
          const increment = (value: number) => Math.min(1000, value + 1)
          page.on('request', (request) => {
            if (request.resourceType() === 'script')
              contextBootstrap.scriptsRequested = increment(contextBootstrap.scriptsRequested)
          })
          page.on('response', (response) => {
            if (response.request().resourceType() !== 'script') return
            if (response.status() === 200)
              contextBootstrap.scriptResponses200 = increment(contextBootstrap.scriptResponses200)
            else contextBootstrap.scriptResponsesNon200 = increment(contextBootstrap.scriptResponsesNon200)
            if (
              !/^(?:text|application)\/(?:javascript|ecmascript)(?:\s*;|$)/i.test(
                response.headers()['content-type'] ?? ''
              )
            )
              contextBootstrap.scriptMimeNonJs = increment(contextBootstrap.scriptMimeNonJs)
          })
          page.on('requestfailed', (request) => {
            if (request.resourceType() === 'script')
              contextBootstrap.scriptsFailed = increment(contextBootstrap.scriptsFailed)
          })
          page.on('console', (message) => {
            if (message.type() !== 'error') return
            // Classify transiently; never retain browser text, URLs or tokens.
            const text = message.text().toLowerCase()
            const category =
              text.includes('content security policy') || text.includes('violates the following content security')
                ? 'csp'
                : text.includes('mime type')
                  ? 'script_mime'
                  : text.includes('dynamically imported module') ||
                      text.includes('loading chunk') ||
                      text.includes('module script')
                    ? 'module_load'
                    : text.includes('hydration')
                      ? 'hydration'
                      : 'other'
            contextBootstrap.consoleErrors[category] = increment(contextBootstrap.consoleErrors[category])
          })
          const document = await page.goto(input.origin + '/admin/inventario', {
            waitUntil: 'networkidle',
            timeout: 30000
          })
          observation.documentStatus = document?.status() ?? null
          const path = new URL(page.url()).pathname
          observation.routeKind =
            path === '/admin/inventario'
              ? 'inventory'
              : path === '/login'
                ? 'login'
                : path === '/admin'
                  ? 'admin'
                  : 'other'
          stage = stage === 'approver_navigation' ? 'approver_panel' : 'proposer_panel'
          const reject = page.getByRole('button', { name: 'Rechazar opcionales', exact: true })
          if (await reject.isVisible()) await reject.click()
          return page
        }
        stage = 'proposer_navigation'
        const proposer = await context(fixture.proposerCookie),
          panel = proposer.getByRole('region', { name: 'Importación de recuentos CSV', exact: true })
        await expect(panel).toBeVisible({ timeout: 15000 })
        stage = 'proposer_preview'
        await panel.locator('[data-count-import-csv]').fill(bridge.csv)
        assert.equal(bridge.state().proposalPosts, 0)
        await panel.locator('[data-count-import-preview]').click()
        await expect(panel.getByText(fixture.sku, { exact: true })).toBeVisible({ timeout: 15000 })
        assert.equal(bridge.state().proposalPosts, 0)
        stage = 'proposer_review'
        await panel.locator('[data-count-import-reason]').fill('Synthetic physical count import reviewed')
        await panel.locator('[data-count-import-reference]').fill('SYNTHETIC-BROWSER-INV010-' + viewport)
        await panel.getByRole('button', { name: 'Revisar propuesta', exact: true }).click()
        await expect(panel.locator('[data-count-import-confirm]')).toBeVisible()
        assert.equal(bridge.state().proposalPosts, 0)
        stage = 'proposer_submit'
        await panel.locator('[data-count-import-confirm]').focus()
        await proposer.keyboard.press('Enter')
        await expect(panel.locator('[data-count-import-check]')).toBeVisible({ timeout: 15000 })
        await expect(panel.locator('[data-count-import-confirm]')).toHaveCount(0)
        assert.equal(bridge.state().proposalPosts, 1)
        stage = 'proposer_recovery'
        await panel.locator('[data-count-import-check]').click()
        await expect(
          panel.getByText('Propuesta confirmada. No se ha modificado el stock; debe aprobarla otro operador.', {
            exact: true
          })
        ).toBeVisible({ timeout: 15000 })
        assert(bridge.state().recovered)
        assert.equal(bridge.state().proposalPosts, 1)
        const importId = bridge.state().importId
        assert(importId)
        stage = 'approver_navigation'
        const approver = await context(fixture.approverCookie),
          review = approver.getByRole('region', { name: 'Importación de recuentos CSV', exact: true })
        stage = 'approver_open'
        await expect(review.locator(`[data-count-import-open="${importId}"]`)).toBeVisible({ timeout: 15000 })
        await review.locator(`[data-count-import-open="${importId}"]`).click()
        await expect(review.locator('[data-count-import-approval-reason]')).toBeVisible({ timeout: 15000 })
        stage = 'approver_review'
        await review.locator('[data-count-import-approval-reason]').fill('Synthetic independent count verification')
        await review.getByRole('button', { name: 'Revisar aprobación', exact: true }).click()
        await expect(review.locator('[data-count-import-confirm]')).toBeVisible()
        assert.equal(bridge.state().approvalPosts, 0)
        stage = 'approver_submit'
        await review.locator('[data-count-import-confirm]').focus()
        await approver.keyboard.press('Enter')
        await expect(
          review.getByText('Recuento aprobado y balances actuales confirmados. No autoriza efectos económicos.', {
            exact: true
          })
        ).toBeVisible({ timeout: 15000 })
        stage = 'domain_completion'
        await bridge.assertComplete()
        assert.equal(transportFailure, false)
        assert.equal(pageErrors, 0)
        for (const page of [proposer, approver])
          assert.equal(
            await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
            false
          )
        for (const created of contexts.splice(0)) await created.close()
        input.scenario?.(INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS[index]!)
        scenarios++
      } catch (error) {
        if (current.page) {
          try {
            const authority = await current.page.evaluate(() => {
              const result = {
                nuxtAppPresent: false,
                hydrating: null as boolean | null,
                runtimeCloudflare: null as boolean | null,
                sessionReady: null as boolean | null,
                loggedIn: null as boolean | null,
                emailVerified: null as boolean | null,
                mfaVerified: null as boolean | null,
                sessionShapeValid: null as boolean | null,
                navigationStatus: null as InventoryCountImportBootstrapDiagnostic['navigationStatus'],
                capabilitiesState: null as InventoryCountImportBootstrapDiagnostic['capabilitiesState'],
                capabilitiesMatchSession: null as boolean | null
              }
              const provider = (window as unknown as { useNuxtApp?: () => unknown }).useNuxtApp
              if (typeof provider !== 'function') return result
              const rawApp = provider()
              if (rawApp === null || typeof rawApp !== 'object' || Array.isArray(rawApp)) return result
              const app = rawApp as Record<string, unknown>
              result.nuxtAppPresent = true
              result.hydrating = typeof app.isHydrating === 'boolean' ? app.isHydrating : null
              // Playwright serializes this callback without outer helpers.
              // Keep checks inline: tsx keepNames wraps local functions in a
              // Node-side __name helper that is not present in the browser.
              const rawConfig = app.$config
              const publicConfig =
                rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
                  ? (rawConfig as Record<string, unknown>).public
                  : null
              const config =
                publicConfig !== null && typeof publicConfig === 'object' && !Array.isArray(publicConfig)
                  ? (publicConfig as Record<string, unknown>)
                  : null
              result.runtimeCloudflare = config ? config.serverRuntime === 'cloudflare' : null
              const rawPayload = app.payload
              const rawState =
                rawPayload !== null && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
                  ? (rawPayload as Record<string, unknown>).state
                  : null
              const state =
                rawState !== null && typeof rawState === 'object' && !Array.isArray(rawState)
                  ? (rawState as Record<string, unknown>)
                  : null
              if (!state) return result
              // Installed Nuxt useState prefixes keys with $s; nuxt-auth-utils
              // owns these two keys. No user/identity values leave this callback.
              const rawSession = state['$snuxt-session']
              const session =
                rawSession !== null && typeof rawSession === 'object' && !Array.isArray(rawSession)
                  ? (rawSession as Record<string, unknown>)
                  : null
              const rawUser = session?.user
              const user =
                rawUser !== null && typeof rawUser === 'object' && !Array.isArray(rawUser)
                  ? (rawUser as Record<string, unknown>)
                  : null
              const rawNavigation = state['$sadmin-navigation']
              const navigation =
                rawNavigation !== null && typeof rawNavigation === 'object' && !Array.isArray(rawNavigation)
                  ? (rawNavigation as Record<string, unknown>)
                  : null
              const rawCapabilities = navigation?.capabilities
              const capabilities =
                rawCapabilities !== null && typeof rawCapabilities === 'object' && !Array.isArray(rawCapabilities)
                  ? (rawCapabilities as Record<string, unknown>)
                  : null
              result.sessionReady = typeof state['$snuxt-auth-ready'] === 'boolean' ? state['$snuxt-auth-ready'] : null
              result.loggedIn = Boolean(user)
              result.emailVerified = user ? user.emailVerified === true : null
              result.mfaVerified = user ? user.mfaVerified === true : null
              const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
              result.sessionShapeValid =
                !!session &&
                typeof session.sessionId === 'string' &&
                uuid.test(session.sessionId) &&
                typeof session.sessionVersion === 'number' &&
                Number.isSafeInteger(session.sessionVersion) &&
                session.sessionVersion > 0
              const status = navigation?.status
              if (
                status === 'idle' ||
                status === 'loading' ||
                status === 'ready' ||
                status === 'error' ||
                status === 'unauthenticated'
              )
                result.navigationStatus = status
              const capabilityState = capabilities?.state
              if (
                capabilityState === 'ready' ||
                capabilityState === 'forbidden' ||
                capabilityState === 'email_unverified' ||
                capabilityState === 'mfa_required'
              )
                result.capabilitiesState = capabilityState
              result.capabilitiesMatchSession =
                capabilities && user && session
                  ? capabilities.identityId === user.id &&
                    capabilities.sessionId === session.sessionId &&
                    capabilities.sessionVersion === session.sessionVersion
                  : null
              return result
            })
            Object.assign(bootstrap, authority)
          } catch {
            /* Missing/closed bootstrap remains explicitly unknown. */
          }
          try {
            const path = new URL(current.page.url()).pathname
            observation.routeKind =
              path === '/admin/inventario'
                ? 'inventory'
                : path === '/login'
                  ? 'login'
                  : path === '/admin'
                    ? 'admin'
                    : 'other'
          } catch {
            /* Unavailable page URL contributes no raw diagnostic. */
          }
          try {
            observation.panelCount = await current.page
              .getByRole('region', { name: 'Importación de recuentos CSV', exact: true })
              .count()
          } catch {
            /* Closed or unavailable DOM remains explicitly unknown. */
          }
        }
        const state = currentBridge?.state()
        throw new InventoryCountImportBrowserError(
          error instanceof InventoryCountImportBrowserError ? error.stage : stage,
          viewport,
          {
            transportFailure,
            pageErrors,
            previewPosts: state?.previewPosts ?? 0,
            proposalPosts: state?.proposalPosts ?? 0,
            approvalPosts: state?.approvalPosts ?? 0,
            lostResponses: state?.lostResponses ?? 0,
            receiptGets: state?.receiptGets ?? 0,
            ...observation,
            bootstrap
          }
        )
      }
    }
    return {
      scenarios,
      browserExecuted: true,
      viewports: [...viewports],
      engine: 'remote_playwright_chromium',
      transport: 'playwright_same_origin_forwarding_to_real_workerd',
      productionAcceptance: false,
      providerConnected: false
    }
  } finally {
    for (const context of contexts) await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}
