import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersistentLocalNewsletterSender } from '../../workers/marketing/local-newsletter-sender'
import { configuredNewsletterEditorial } from '../../workers/runtime/customer-operations-config'
import { transportReady } from '../../workers/marketing/newsletter-campaign-transport'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { environment } from '../support/customer-operations-fixture'
import type { DatabaseSync } from 'node:sqlite'

const opened: DatabaseSync[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
  vi.restoreAllMocks()
})
const message = () => ({
  deliveryId: crypto.randomUUID(),
  to: 'recipient@example.invalid',
  from: 'newsletter@example.test',
  subject: 'Synthetic editorial test',
  html: '<p>Validation, no email delivery.</p>',
  text: 'Validation, no email delivery.',
  headers: { 'List-Unsubscribe': '<https://neteco.invalid/newsletter/baja?token=synthetic-secret-not-persisted>' }
})
async function fixture() {
  const sqlite = await openMigratedDatabase()
  opened.push(sqlite)
  const database = d1OverSqlite(sqlite)
  return { sqlite, database, sender: new PersistentLocalNewsletterSender(database) }
}
describe('explicit local synthetic newsletter receipt port', () => {
  it('persists only digest and clearly synthetic receipt, replay survives sender reconstruction', async () => {
    const world = await fixture(),
      input = message(),
      outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('unexpected_outbound')
      })
    const result = await world.sender.send(input)
    expect(result.messageId).toMatch(/^SYNTHETIC-NEWSLETTER-[0-9a-f]{64}$/)
    expect(await new PersistentLocalNewsletterSender(world.database).send(input)).toEqual(result)
    const rows = world.sqlite.prepare('SELECT * FROM newsletter_editorial_fake_receipts').all()
    expect(rows).toHaveLength(1)
    const recorded = JSON.stringify(rows)
    for (const value of [input.to, input.from, input.subject, input.html, input.text, 'synthetic-secret-not-persisted'])
      expect(recorded).not.toContain(value)
    expect(outbound).not.toHaveBeenCalled()
  })
  it('same delivery with changed payload fails without mutating its receipt', async () => {
    const world = await fixture(),
      input = message()
    await world.sender.send(input)
    const before = world.sqlite.prepare('SELECT * FROM newsletter_editorial_fake_receipts').all()
    await expect(world.sender.send({ ...input, text: 'Changed payload' })).rejects.toThrow()
    expect(world.sqlite.prepare('SELECT * FROM newsletter_editorial_fake_receipts').all()).toEqual(before)
  })
  it.each([
    { to: 'real@neteco.es' },
    { from: 'real@neteco.es' },
    { to: 'recipient@example.invalid.attacker.com' },
    { subject: 'Subject\r\nBcc: real@neteco.es' },
    { headers: { 'List-Unsubscribe': '<https://neteco.es/newsletter/baja>' } },
    { headers: { 'List-Unsubscribe': '<https://name:secret@neteco.invalid/newsletter/baja>' } },
    { headers: { 'List-Unsubscribe': '<https://neteco.invalid/not-unsubscribe>' } },
    { deliveryId: 'non-uuid' }
  ])('rejects nonsynthetic or malformed message %# before database use', async (change) => {
    const database = { prepare: vi.fn() } as unknown as D1Database,
      sender = new PersistentLocalNewsletterSender(database)
    await expect(sender.send({ ...message(), ...change })).rejects.toThrow()
    expect(database.prepare).not.toHaveBeenCalled()
  })
  it('keeps synthetic receipts immutable at schema level', async () => {
    const world = await fixture()
    await world.sender.send(message())
    expect(() =>
      world.sqlite.exec("UPDATE newsletter_editorial_fake_receipts SET created_at='2026-10-03T00:00:00Z'")
    ).toThrow('immutable')
    expect(() => world.sqlite.exec('DELETE FROM newsletter_editorial_fake_receipts')).toThrow('immutable')
  })
  it('root runtime requires separate explicit opt-in and local environment, never accesses a real binding', async () => {
    const world = await fixture(),
      access = vi.fn(() => {
        throw new Error('real_binding_forbidden')
      }),
      env = environment({
        DB: world.database,
        NEWSLETTER_EDITORIAL_ENABLED: 'true',
        NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'true',
        NEWSLETTER_HMAC_KEY: Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64url')
      })
    Object.defineProperty(env, 'NEWSLETTER_EMAIL', { get: access })
    const off = configuredNewsletterEditorial(env)
    expect(transportReady(off.transport, off.publicOrigin)).toBe(false)
    expect(world.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_fake_receipts').get()).toEqual({ n: 0 })
    env.NEWSLETTER_LOCAL_VALIDATION_ENABLED = 'true'
    const local = configuredNewsletterEditorial(env)
    expect(transportReady(local.transport, local.publicOrigin)).toBe(true)
    expect(local.transport?.senderFactory?.()?.kind).toBe('local-fake')
    await local.transport!.senderFactory!()!.send(message())
    expect(access).not.toHaveBeenCalled()
    const preview = configuredNewsletterEditorial(
      environment({ APP_ENV: 'preprod', NEWSLETTER_LOCAL_VALIDATION_ENABLED: 'true' })
    )
    expect(preview.transport?.mode).toBe('disabled')
    expect(preview.transport?.senderFactory).toBeUndefined()
  })
})
