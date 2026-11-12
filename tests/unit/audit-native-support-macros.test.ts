import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { supportFixture, ORIGIN } from './d1-support-fixture'
import {
  auditNativeSupportMacros,
  type NativeSupportMacrosAuditInput
} from '../../scripts/lib/audit-native-support-macros'
import { testUuid } from '../support/deterministic'

describe('native support macro acceptance over real HTTP and SQLite', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  let input: NativeSupportMacrosAuditInput
  beforeEach(async () => {
    f = await supportFixture()
    if (!f.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='support_macro_commands'").get())
      f.sqlite.exec(await readFile(new URL('../../db/d1/migrations/0060_support_macros.sql', import.meta.url), 'utf8'))
    input = {
      database: f.database,
      dispatch: f.dispatch,
      origin: ORIGIN,
      adminCookie: f.adminCookie,
      customerCookie: f.customerCookie,
      scenario: () => undefined
    }
  })
  afterEach(() => f.sqlite.close())
  it('proves synthetic review, exact queued reply, withdrawal, historical replay and no extra effects', async () => {
    const checks: string[] = [],
      before = f.economic()
    const proof = await auditNativeSupportMacros({ ...input, scenario: (name) => checks.push(name) })
    expect(proof).toMatchObject({ noExternalLegalApproval: true, queuedOnly: true, replayNoExtraSideEffect: true })
    expect(proof.scenarios).toBe(checks.length)
    expect(checks).toEqual([
      'native_support_macros_verified_general_ticket',
      'native_support_macros_draft',
      'native_support_macros_explicitly_synthetic_review',
      'native_support_macros_required_personalization',
      'native_support_macros_exact_preview',
      'native_support_macros_confirmed_exact_reply_queued',
      'native_support_macros_durable_queued_evidence',
      'native_support_macros_withdraw',
      'native_support_macros_withdrawn_exact_replay_no_extra_effect',
      'native_support_macros_withdrawn_new_send_denied',
      'native_support_macros_library_and_exact_historical_detail',
      'native_support_macros_private_authority_uniform_denials'
    ])
    expect(f.economic()).toEqual(before)
    expect(
      f.sqlite.prepare('SELECT state FROM support_macro_commands WHERE macro_id=? ORDER BY version').all(proof.macroId)
    ).toEqual([{ state: 'draft' }, { state: 'approved' }, { state: 'withdrawn' }])
    expect(
      f.sqlite
        .prepare('SELECT version,order_id,customer_id IS NOT NULL AS verified FROM support_tickets WHERE public_ref=?')
        .get(proof.publicRef)
    ).toMatchObject({ version: 2, order_id: null, verified: 1 })
  })
  it('rejects a real origin before dispatch or database access', async () => {
    let calls = 0
    await expect(
      auditNativeSupportMacros({
        ...input,
        origin: 'https://neteco.es',
        dispatch: async () => {
          calls++
          throw Error('unexpected')
        }
      })
    ).rejects.toThrow('native_support_macros_local_origin_required')
    expect(calls).toBe(0)
  })
  it('rejects invalid cookies before any effects', async () => {
    await expect(auditNativeSupportMacros({ ...input, customerCookie: 'bad\r\ncookie' })).rejects.toThrow(
      'native_support_macros_cookie_invalid'
    )
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_macro_commands').get()).toEqual({ n: 0 })
  })
  it('does not turn a dispatch outage into acceptance evidence', async () => {
    await expect(
      auditNativeSupportMacros({
        ...input,
        dispatch: async () => {
          throw Error('synthetic_dispatch_outage')
        }
      })
    ).rejects.toThrow('synthetic_dispatch_outage')
  })
  it('rejects a fabricated successful DTO instead of trusting HTTP status', async () => {
    await expect(
      auditNativeSupportMacros({
        ...input,
        dispatch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
      })
    ).rejects.toThrow('native_support_macros_private_response_required')
  })
  it('requires authoritative D1 evidence even when genuine HTTP succeeds', async () => {
    const database = new Proxy(f.database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return () => {
            throw Error('synthetic_evidence_outage')
          }
        return Reflect.get(target, key, receiver)
      }
    })
    await expect(auditNativeSupportMacros({ ...input, database })).rejects.toThrow('synthetic_evidence_outage')
  })
  it('rejects a plausible but fabricated reply receipt against the real ledger', async () => {
    await expect(
      auditNativeSupportMacros({
        ...input,
        dispatch: async (request) => {
          const response = await f.dispatch(request)
          if (
            request.method === 'PUT' &&
            /^\/api\/admin\/support\/SOP-/.test(new URL(request.url).pathname) &&
            response.status === 200
          ) {
            const raw = (await response.json()) as Record<string, unknown>
            return new Response(JSON.stringify({ ...raw, commandId: testUuid() }), {
              status: 200,
              headers: response.headers
            })
          }
          return response
        }
      })
    ).rejects.toThrow('native_support_macros_reply_ledger_mismatch')
  })
})
