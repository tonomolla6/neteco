import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { supportFixture, ORIGIN } from './d1-support-fixture'
import { auditNativeSupport } from '../../scripts/lib/audit-native-support'
let f: Awaited<ReturnType<typeof supportFixture>>
beforeEach(async () => {
  f = await supportFixture()
})
afterEach(() => {
  f.sqlite.close()
})
describe('native support helper contract over real SQL and HTTP handlers', () => {
  it('exercises genuine existing checkout ownership, contact, internal privacy, CAS and no economics', async () => {
    const checks: string[] = []
    const evidence = await auditNativeSupport({
      database: f.database,
      dispatch: f.dispatch,
      origin: ORIGIN,
      adminCookie: f.adminCookie,
      customerCookie: f.customerCookie,
      orderId: f.order,
      scenario: (name) => checks.push(name)
    })
    expect(evidence.scenarios).toBe(26)
    expect(evidence.scenarios).toBe(checks.length)
    expect(evidence).toMatchObject({
      inventoryUnchanged: true,
      contractUnchanged: true,
      finalVersion: 5,
      privateNotesRedacted: true,
      anonymousOwnership: false,
      attachmentsExercised: false,
      providerAuthority: false,
      scheduledEntrypointExercised: false
    })
  })
  it('rejects remote real origin before touching HTTP or database', async () => {
    let dispatched = false
    await expect(
      auditNativeSupport({
        database: f.database,
        dispatch: async (request) => {
          dispatched = true
          return f.dispatch(request)
        },
        origin: 'https://neteco.es',
        adminCookie: f.adminCookie,
        customerCookie: f.customerCookie,
        orderId: f.order,
        scenario: () => undefined
      })
    ).rejects.toThrow('native_support_local_origin_required')
    expect(dispatched).toBe(false)
  })
})
