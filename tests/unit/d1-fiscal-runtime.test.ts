import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchFiscalRuntime } from '../../workers/fiscal/runtime-dispatch'
import { approveFiscalPolicy, fiscalMappingFingerprint, withdrawFiscalPolicy } from '../../workers/fiscal/issuance'
import {
  fiscalRuntimeWorld,
  FISCAL_RUNTIME_NOW,
  fiscalRuntimeClaims,
  fiscalRuntimeMappings
} from './d1-fiscal-runtime-fixture'

const opened: DatabaseSync[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  vi.restoreAllMocks()
})
async function world() {
  const w = await fiscalRuntimeWorld(opened)
  const resolver = vi.fn(async () => w.provider)
  const deps = { database: w.database, storage: w.storage, providerResolver: resolver }
  const config = {
    appEnvironment: 'local' as const,
    now: FISCAL_RUNTIME_NOW,
    flags: { enabled: true, localValidationEnabled: true },
    policyIds: [w.policy.id]
  }
  return { ...w, resolver, deps, config }
}
describe('governed fiscal Cloudflare executor without external calls', () => {
  it.each([{}, { flags: { enabled: false } }, { flags: { enabled: 'false' } }, { policyIds: [] }])(
    'never resolves a provider without opt-in and a server-owned selection %#',
    async (change) => {
      const w = await world()
      const config = { ...w.config, ...change }
      if (!Object.keys(change).length) delete (config as { flags?: unknown }).flags
      expect(await dispatchFiscalRuntime(w.deps, config)).toMatchObject({ disabled: true, completed: 0 })
      expect(w.resolver).not.toHaveBeenCalled()
    }
  )
  it('requires local-only opt-in and never passes synthetic policy to preview/production', async () => {
    const w = await world()
    for (const appEnvironment of ['local', 'preview', 'production'] as const) {
      expect(
        await dispatchFiscalRuntime(w.deps, { ...w.config, appEnvironment, flags: { enabled: true } })
      ).toMatchObject({ completed: 0, unavailable: 1 })
    }
    expect(w.resolver).not.toHaveBeenCalled()
  })
  it('resumes persisted queued intents exactly once and preserves the durable email obligation', async () => {
    const w = await world()
    expect(await dispatchFiscalRuntime(w.deps, w.config)).toMatchObject({ completed: 1, policies: 1 })
    expect(await dispatchFiscalRuntime(w.deps, w.config)).toMatchObject({ completed: 0 })
    expect(
      w.sqlite.prepare("SELECT count(*) AS n FROM email_outbox_events WHERE event_type='invoice.issued'").get()!.n
    ).toBe(1)
  })
  it('does not consume or block another approved policy candidate', async () => {
    const w = await world(),
      second = await w.approve('policy-two', 'OTHER'),
      other = await w.paid(second)
    expect(await dispatchFiscalRuntime(w.deps, w.config)).toMatchObject({ completed: 1 })
    expect(
      w.sqlite.prepare('SELECT status,attempts FROM fiscal_issuance_work WHERE intent_id=?').get(other.intentId)
    ).toEqual({ status: 'queued', attempts: 0 })
    expect(await dispatchFiscalRuntime(w.deps, { ...w.config, policyIds: [second.id] })).toMatchObject({ completed: 1 })
  })
  it('rechecks withdrawal after resolving the adapter and leaves the intent unissued', async () => {
    const w = await world()
    w.resolver.mockImplementation(async () => {
      await withdrawFiscalPolicy(w.database, fiscalRuntimeClaims, w.policy.id, 'Synthetic withdrawn before issuing', {
        now: FISCAL_RUNTIME_NOW,
        idempotencyKey: 'withdraw'
      })
      return w.provider
    })
    expect(await dispatchFiscalRuntime(w.deps, w.config)).toMatchObject({ completed: 0, unavailable: 1 })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_fake_invoices').get()!.n).toBe(0)
  })
  it('quarantines expired issuing markers while disabled and never reissues lost outcomes', async () => {
    const w = await world()
    w.provider.failures.issue = 'accepted_response_lost'
    expect(await dispatchFiscalRuntime(w.deps, w.config)).toMatchObject({ uncertain: 1 })
    expect(await dispatchFiscalRuntime(w.deps, w.config)).toMatchObject({ completed: 0, uncertain: 0 })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_fake_invoices').get()!.n).toBe(1)
    w.sqlite.exec(
      "UPDATE fiscal_issuance_work SET status='issuing',generation=generation+1,lease_token='expired',lease_until='2026-10-03T08:00:00Z'"
    )
    w.resolver.mockClear()
    expect(await dispatchFiscalRuntime(w.deps, { ...w.config, flags: { enabled: false } })).toMatchObject({
      disabled: true,
      uncertain: 1
    })
    expect(w.resolver).not.toHaveBeenCalled()
  })
  it('refuses invalid flags, sparse/getter configuration and missing dependencies without emission', async () => {
    const w = await world(),
      getter = vi.fn(() => true)
    for (const flags of [
      { enabled: 1 },
      { enabled: 'TRUE' },
      Object.defineProperty({}, 'enabled', { enumerable: true, get: getter })
    ])
      await expect(dispatchFiscalRuntime(w.deps, { ...w.config, flags })).rejects.toThrow()
    await expect(dispatchFiscalRuntime(w.deps, { ...w.config, policyIds: new Array(1) })).rejects.toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(await dispatchFiscalRuntime({ database: w.database }, w.config)).toMatchObject({
      completed: 0,
      unavailable: 1
    })
    expect(w.resolver).not.toHaveBeenCalled()
  })
  it('routes Beply sandbox only through an explicitly selected approved policy and injected offline adapter', async () => {
    const w = await world()
    const policy = await approveFiscalPolicy(
      w.database,
      fiscalRuntimeClaims,
      {
        idempotencyKey: 'offline-sandbox-policy',
        provider: 'beply',
        environment: 'sandbox',
        series: 'OFFLINE',
        trigger: 'after_payment_capture',
        mappings: fiscalRuntimeMappings,
        evidenceRef: 'offline-contract-test-not-provider-acceptance',
        reason: 'Synthetic offline adapter contract exercise only'
      },
      { now: FISCAL_RUNTIME_NOW }
    )
    const order = await w.paid(policy)
    const adapter = {
      name: 'beply' as const,
      environment: 'sandbox' as const,
      mappingFingerprint: await fiscalMappingFingerprint(fiscalRuntimeMappings),
      issueInvoice: vi.fn(async () => {
        throw new Error('offline fixture without provider traffic or acceptance')
      }),
      downloadPdf: vi.fn()
    }
    const resolver = vi.fn(async () => adapter)
    const config = { ...w.config, policyIds: [policy.id] }
    for (const appEnvironment of ['local', 'production'] as const)
      expect(
        await dispatchFiscalRuntime({ ...w.deps, providerResolver: resolver }, { ...config, appEnvironment })
      ).toMatchObject({ unavailable: 1, completed: 0 })
    expect(resolver).not.toHaveBeenCalled()
    expect(
      await dispatchFiscalRuntime({ ...w.deps, providerResolver: resolver }, { ...config, appEnvironment: 'preview' })
    ).toMatchObject({ uncertain: 1, completed: 0 })
    expect(adapter.issueInvoice).toHaveBeenCalledTimes(1)
    expect(w.sqlite.prepare('SELECT status FROM fiscal_issuance_work WHERE intent_id=?').get(order.intentId)).toEqual({
      status: 'uncertain'
    })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_provider_receipts').get()!.n).toBe(0)
  })
  it('rejects injected mapping drift and getter adapter metadata without calling issue', async () => {
    const w = await world(),
      getter = vi.fn(() => w.provider.mappingFingerprint)
    const wrong = {
      ...w.provider,
      name: 'local_fake' as const,
      environment: 'local_validation' as const,
      mappingFingerprint: 'f'.repeat(64),
      issueInvoice: vi.fn(),
      downloadPdf: w.provider.downloadPdf.bind(w.provider)
    }
    expect(await dispatchFiscalRuntime({ ...w.deps, providerResolver: () => wrong }, w.config)).toMatchObject({
      unavailable: 1,
      completed: 0
    })
    Object.defineProperty(wrong, 'mappingFingerprint', { get: getter, enumerable: true })
    expect(await dispatchFiscalRuntime({ ...w.deps, providerResolver: () => wrong }, w.config)).toMatchObject({
      unavailable: 1,
      completed: 0
    })
    expect(getter).not.toHaveBeenCalled()
    expect(wrong.issueInvoice).not.toHaveBeenCalled()
    expect(w.sqlite.prepare('SELECT status,attempts FROM fiscal_issuance_work').get()).toEqual({
      status: 'queued',
      attempts: 0
    })
  })
})
