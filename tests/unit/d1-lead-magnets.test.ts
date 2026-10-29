import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_CLAIMS,
  NOW,
  NO_MFA_CLAIMS,
  PLAIN_CLAIMS,
  growthDatabase,
  seedGrowthIdentities
} from './d1-growth-fixture'
import {
  leadMagnetSummary,
  processLeadMagnetDeliveries,
  requestLeadMagnetCopy,
  type LeadMagnetSender
} from '../../workers/growth/lead-magnets'
import { GrowthError } from '../../workers/growth/common'

const PEPPER = 'test-lead-pepper-at-least-32-characters-long!!'
const CTX = { pepper: PEPPER, address: '203.0.113.7', publicOrigin: 'https://shop.neteco.test' }
const SLUG = 'checklist-seguridad-productos-quimicos'
const REQ = { magnetSlug: SLUG, email: 'ana@example.com', marketingConsent: false }

let sqlite: DatabaseSync
let db: D1Database
beforeEach(async () => {
  const fixture = await growthDatabase()
  sqlite = fixture.sqlite
  db = fixture.db
  seedGrowthIdentities(sqlite)
})
afterEach(() => {
  if (sqlite?.isOpen) sqlite.close()
})
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof GrowthError ? e.code : `unexpected:${String(e)}`)
  )
const count = (table: string) => (sqlite.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c

describe('MKT-029 requesting a copy', () => {
  it('queues the copy with only the e-mail and no consent record when unchecked', async () => {
    expect(await requestLeadMagnetCopy(db, REQ, CTX, NOW)).toEqual({ accepted: true })
    const row = sqlite.prepare('SELECT magnet_slug, email, status, attempts FROM lead_magnet_requests').get()
    expect(row).toEqual({ magnet_slug: SLUG, email: 'ana@example.com', status: 'queued', attempts: 0 })
    expect(count('lead_magnet_consents')).toBe(0)
  })
  it('records optional marketing consent as separate evidence, pending confirmation', async () => {
    await requestLeadMagnetCopy(db, { ...REQ, marketingConsent: true }, CTX, NOW)
    const consent = sqlite
      .prepare('SELECT purpose, text_version, status, email_hash FROM lead_magnet_consents')
      .get() as Record<string, string>
    expect(consent).toMatchObject({
      purpose: 'marketing_newsletter',
      text_version: 'lead-magnet-2026-10',
      status: 'pending_confirmation'
    })
    expect(consent.email_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(consent)).not.toContain('ana@')
  })
  it('does not condition delivery on consent: both variants are queued identically', async () => {
    await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    await requestLeadMagnetCopy(db, { ...REQ, email: 'luis@example.com', marketingConsent: true }, CTX, NOW)
    expect(sqlite.prepare("SELECT count(*) c FROM lead_magnet_requests WHERE status='queued'").get()).toEqual({ c: 2 })
  })
  it('is idempotent per e-mail and magnet and answers identically (no enumeration)', async () => {
    const a = await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    const b = await requestLeadMagnetCopy(db, { ...REQ, email: 'ANA@example.com ' }, CTX, NOW)
    expect(b).toEqual(a)
    expect(count('lead_magnet_requests')).toBe(1)
  })
  it('adds consent later to an existing request only once', async () => {
    await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    await requestLeadMagnetCopy(db, { ...REQ, marketingConsent: true }, CTX, NOW)
    await requestLeadMagnetCopy(db, { ...REQ, marketingConsent: true }, CTX, NOW)
    expect(count('lead_magnet_consents')).toBe(1)
    expect(count('lead_magnet_requests')).toBe(1)
  })
  it('keeps one request per magnet for the same e-mail', async () => {
    await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    await requestLeadMagnetCopy(db, { ...REQ, magnetSlug: 'guia-limpieza-desinfeccion-hosteleria' }, CTX, NOW)
    expect(count('lead_magnet_requests')).toBe(2)
  })
  it('stores the dedupe hash keyed with the pepper, never a bare digest of the address', async () => {
    await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    const { email_hash } = sqlite.prepare('SELECT email_hash FROM lead_magnet_requests').get() as { email_hash: string }
    const bare = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ana@example.com'))),
      (b) => b.toString(16).padStart(2, '0')
    ).join('')
    expect(email_hash).not.toBe(bare)
  })
  it('validates input, magnet and extra personal fields', async () => {
    expect(await code(requestLeadMagnetCopy(db, { ...REQ, email: 'nope' }, CTX, NOW))).toBe('invalid_input')
    expect(await code(requestLeadMagnetCopy(db, { ...REQ, name: 'Ana' }, CTX, NOW))).toBe('invalid_input')
    expect(await code(requestLeadMagnetCopy(db, { ...REQ, magnetSlug: 'inexistente' }, CTX, NOW))).toBe('not_found')
    expect(await code(requestLeadMagnetCopy(db, { ...REQ, marketingConsent: 'si' }, CTX, NOW))).toBe('invalid_input')
    expect(count('lead_magnet_requests')).toBe(0)
  })
  it('does not offer a request form for the calculator, which has nothing to e-mail beyond a link', async () => {
    expect(await requestLeadMagnetCopy(db, { ...REQ, magnetSlug: 'calculadora-dilucion' }, CTX, NOW)).toEqual({
      accepted: true
    })
  })
  it('silently accepts honeypot submissions without storing anything or spending quota', async () => {
    expect(await requestLeadMagnetCopy(db, { ...REQ, website: 'http://spam.example' }, CTX, NOW)).toEqual({
      accepted: true
    })
    expect(count('lead_magnet_requests')).toBe(0)
    expect(count('lead_magnet_request_limits')).toBe(0)
  })
  it('rate limits per address and window, and recovers after the window', async () => {
    for (let i = 0; i < 5; i++) await requestLeadMagnetCopy(db, { ...REQ, email: `u${i}@example.com` }, CTX, NOW)
    expect(await code(requestLeadMagnetCopy(db, { ...REQ, email: 'u9@example.com' }, CTX, NOW))).toBe('rate_limited')
    expect(
      await code(
        requestLeadMagnetCopy(db, { ...REQ, email: 'u9@example.com' }, { ...CTX, address: '203.0.113.8' }, NOW)
      )
    ).toBe('ok')
    expect(
      await code(
        requestLeadMagnetCopy(
          db,
          { ...REQ, email: 'u9@example.com' },
          { ...CTX, address: '203.0.113.7' },
          '2026-10-29T13:00:01Z'
        )
      )
    ).toBe('ok')
  })
  it('fails closed when abuse controls are unavailable', async () => {
    expect(await code(requestLeadMagnetCopy(db, REQ, { ...CTX, address: null }, NOW))).toBe('service_unavailable')
    expect(await code(requestLeadMagnetCopy(db, REQ, { ...CTX, pepper: 'short' }, NOW))).toBe('service_unavailable')
    expect(
      await code(requestLeadMagnetCopy(db, REQ, { ...CTX, pepper: 'local-only-pepper-pepper-pepper-pepper' }, NOW))
    ).toBe('service_unavailable')
  })
  it('stores one row for simultaneous identical requests', async () => {
    const results = await Promise.all([
      requestLeadMagnetCopy(db, REQ, CTX, NOW),
      requestLeadMagnetCopy(db, REQ, CTX, NOW)
    ])
    expect(results).toEqual([{ accepted: true }, { accepted: true }])
    expect(count('lead_magnet_requests')).toBe(1)
  })
})

describe('MKT-029 delivery and data retention', () => {
  const sender = (impl?: LeadMagnetSender['send']) => ({ send: vi.fn(impl ?? (async () => undefined)) })
  it('sends the transactional copy, then redacts the e-mail and marks it sent', async () => {
    await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    const s = sender()
    const result = await processLeadMagnetDeliveries(db, s, CTX.publicOrigin, NOW)
    expect(result).toEqual({ sent: 1, failed: 0, retried: 0 })
    expect(s.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ana@example.com', subject: expect.stringContaining('Checklist') })
    )
    expect(sqlite.prepare('SELECT status, email, sent_at FROM lead_magnet_requests').get()).toEqual({
      status: 'sent',
      email: null,
      sent_at: NOW
    })
  })
  it('sends the same content whatever the consent', async () => {
    await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    await requestLeadMagnetCopy(db, { ...REQ, email: 'luis@example.com', marketingConsent: true }, CTX, NOW)
    const s = sender()
    await processLeadMagnetDeliveries(db, s, CTX.publicOrigin, NOW)
    const [a, b] = s.send.mock.calls.map((c) => (c[0] as { text: string }).text)
    expect(a).toBe(b)
  })
  it('retries a failing send up to three attempts, then fails and redacts', async () => {
    await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    const s = sender(async () => {
      throw new Error('smtp down')
    })
    expect(await processLeadMagnetDeliveries(db, s, CTX.publicOrigin, NOW)).toEqual({ sent: 0, failed: 0, retried: 1 })
    expect(await processLeadMagnetDeliveries(db, s, CTX.publicOrigin, NOW)).toEqual({ sent: 0, failed: 0, retried: 1 })
    expect(await processLeadMagnetDeliveries(db, s, CTX.publicOrigin, NOW)).toEqual({ sent: 0, failed: 1, retried: 0 })
    expect(sqlite.prepare('SELECT status, email, attempts FROM lead_magnet_requests').get()).toEqual({
      status: 'failed',
      email: null,
      attempts: 3
    })
    expect(await processLeadMagnetDeliveries(db, s, CTX.publicOrigin, NOW)).toEqual({ sent: 0, failed: 0, retried: 0 })
  })
  it('one failing recipient does not block the others', async () => {
    await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    await requestLeadMagnetCopy(db, { ...REQ, email: 'luis@example.com' }, CTX, NOW)
    const s = sender(async (m) => {
      if (m.to === 'ana@example.com') throw new Error('bounce')
    })
    expect(await processLeadMagnetDeliveries(db, s, CTX.publicOrigin, NOW)).toEqual({ sent: 1, failed: 0, retried: 1 })
  })
  it('processes a bounded batch', async () => {
    for (let i = 0; i < 30; i++)
      await requestLeadMagnetCopy(
        db,
        { ...REQ, email: `u${i}@example.com` },
        { ...CTX, address: `203.0.113.${i + 10}` },
        NOW
      )
    const s = sender()
    const result = await processLeadMagnetDeliveries(db, s, CTX.publicOrigin, NOW)
    expect(result.sent).toBe(25)
  })
  it('never re-sends a delivered copy and a re-request does not re-queue it', async () => {
    await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    await processLeadMagnetDeliveries(db, sender(), CTX.publicOrigin, NOW)
    await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    const s = sender()
    expect(await processLeadMagnetDeliveries(db, s, CTX.publicOrigin, NOW)).toEqual({ sent: 0, failed: 0, retried: 0 })
    expect(s.send).not.toHaveBeenCalled()
  })
  it('protects delivered requests and consent evidence from change or deletion', async () => {
    await requestLeadMagnetCopy(db, { ...REQ, marketingConsent: true }, CTX, NOW)
    await processLeadMagnetDeliveries(db, sender(), CTX.publicOrigin, NOW)
    expect(() => sqlite.exec("UPDATE lead_magnet_requests SET status='failed', sent_at=NULL")).toThrow(
      /immutable|constraint/i
    )
    expect(() => sqlite.exec('DELETE FROM lead_magnet_requests')).toThrow(/immutable/)
    expect(() => sqlite.exec("UPDATE lead_magnet_consents SET text_version='x-x-x'")).toThrow(/immutable/)
    expect(() => sqlite.exec('DELETE FROM lead_magnet_consents')).toThrow(/immutable/)
  })
})

describe('MKT-029 administrative summary', () => {
  it('reports counts per magnet and consent rate without any e-mail address', async () => {
    await requestLeadMagnetCopy(db, REQ, CTX, NOW)
    await requestLeadMagnetCopy(db, { ...REQ, email: 'luis@example.com', marketingConsent: true }, CTX, NOW)
    const summary = await leadMagnetSummary(db, ADMIN_CLAIMS, NOW)
    expect(summary).toEqual([
      { magnetSlug: SLUG, requested: 2, queued: 2, sent: 0, failed: 0, withMarketingConsent: 1 }
    ])
    expect(JSON.stringify(summary)).not.toContain('@')
  })
  it('requires live admin authorization', async () => {
    expect(await code(leadMagnetSummary(db, PLAIN_CLAIMS, NOW))).toBe('forbidden')
    expect(await code(leadMagnetSummary(db, NO_MFA_CLAIMS, NOW))).toBe('mfa_required')
  })
})
