import { afterEach, describe, expect, it, vi } from 'vitest'
import canary from '../../workers/canary'

const mocks = vi.hoisted(() => ({ reset: vi.fn(async () => undefined) }))
vi.mock('../../workers/developer-platform/b2b-public-api', async (original) => ({
  ...(await original<typeof import('../../workers/developer-platform/b2b-public-api')>()),
  resetB2bSandbox: mocks.reset
}))

describe('mantenimiento programado del sandbox B2B', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    mocks.reset.mockClear()
  })
  const event = { scheduledTime: Date.parse('2026-10-30T00:01:00Z') } as ScheduledController
  it('invoca el borrado acotado con el reloj del evento cuando la función está habilitada', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const database = {} as D1Database
    const env = { DB: database, AUTH_ENABLED: 'true', B2B_PUBLIC_API_ENABLED: 'true' } as unknown as CloudflareEnv
    await expect(canary.scheduled(event, env)).rejects.toThrow('scheduled_jobs_failed:')
    expect(mocks.reset).toHaveBeenCalledWith(database, '2026-10-30T00:01:00Z')
  })
  it('no ejecuta el mantenimiento con la función deshabilitada', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const env = { DB: {}, AUTH_ENABLED: 'false', B2B_PUBLIC_API_ENABLED: 'false' } as unknown as CloudflareEnv
    await expect(canary.scheduled(event, env)).rejects.toThrow('scheduled_jobs_failed:')
    expect(mocks.reset).not.toHaveBeenCalled()
  })
})
