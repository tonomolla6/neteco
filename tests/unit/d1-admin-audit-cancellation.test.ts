import { readFile, readdir } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { cancelD1UnpaidOrder } from '../../workers/catalog/order-cancellation'
import { readD1AdminAudit } from '../../workers/auth/admin-audit'

it('projects a proven administrative cancellation and excludes customer cancellations without inferring roles', async () => {
  const f = await returnsFixture()
  try {
    const directory = new URL('../../db/d1/migrations/', import.meta.url)
    const names = (await readdir(directory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 4)) > 62)
      .sort()
    f.sqlite.exec(
      'BEGIN;\n' +
        (await Promise.all(names.map((name) => readFile(new URL(name, directory), 'utf8')))).join('\n') +
        '\nCOMMIT;'
    )
    f.sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-verified-factor','[]',?,?)"
      )
      .run(CLAIMS.identityId, utc(-60000), utc(-60000))
    const input = {
      expectedStatus: 'awaiting_payment' as const,
      reason: 'Cancelación administrativa explícita para auditoría.'
    }
    const adminOrder = await f.order({ paid: false, delivered: false })
    const adminKey = crypto.randomUUID()
    await cancelD1UnpaidOrder(f.database, CLAIMS, adminOrder, adminKey, input, {
      audience: 'admin',
      ipHash: 'a'.repeat(64)
    })
    const customerOrder = await f.order({ paid: false, delivered: false })
    await cancelD1UnpaidOrder(f.database, BUYER_CLAIMS, customerOrder, crypto.randomUUID(), input, {
      audience: 'customer'
    })
    const audit = await readD1AdminAudit(f.database, CLAIMS, { family: 'cancellation' })
    expect(audit.items).toHaveLength(1)
    expect(audit.items[0]).toMatchObject({
      resourceId: adminOrder,
      actorId: CLAIMS.identityId,
      commandId: adminKey,
      sessionId: CLAIMS.sessionId,
      ipHash: 'a'.repeat(64)
    })
    expect(audit.items.map((item) => item.resourceId)).not.toContain(customerOrder)
    expect(JSON.stringify(audit)).not.toContain(input.reason)
  } finally {
    f.sqlite.close()
  }
})
