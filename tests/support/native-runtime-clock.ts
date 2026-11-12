import { afterEach, vi } from 'vitest'

let synchronized = false
afterEach(() => {
  if (synchronized) vi.useRealTimers()
  synchronized = false
})

/** Native D1 owns its clock. Anchor relative fixtures to that real authority,
 * after starting workerd, rather than moving the native engine's time. */
export async function syncNativeTestClock(database: D1Database): Promise<string> {
  const clock = await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").first<{ now: string }>()
  if (!clock || !Number.isFinite(Date.parse(clock.now))) throw new Error('native_clock_unconfirmed')
  vi.setSystemTime(clock.now)
  synchronized = true
  return clock.now.replace(/\.\d{3}Z$/, 'Z')
}
