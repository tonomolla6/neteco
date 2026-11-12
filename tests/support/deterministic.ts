// Deterministic replacements for wall-clock time and random UUIDs in tests
// (enforced by scripts/audit-test-determinism.ts).

const EPOCH_MS = Date.UTC(2026, 0, 15, 9, 0, 0)
let clockTicks = 0
let uuidCounter = 0
let runtimeClock: { read(fallback: number): number; peek(): number | null } | undefined

/** Installed by Vitest setup; Playwright and plain data generators keep the fixed fallback. */
export function setTestRuntimeClock(clock: NonNullable<typeof runtimeClock>) {
  runtimeClock = clock
}
export const hasTestRuntimeClock = () => runtimeClock !== undefined
export const currentTestInstant = () => runtimeClock?.peek() ?? null

/** Fixed clock advancing 1 ms per read, aligned with the tested runtime's clock. */
export function testNow(): number {
  const fallback = EPOCH_MS + clockTicks++
  return runtimeClock?.read(fallback) ?? fallback
}

/** Unique, RFC 4122 v4-shaped UUIDs from a per-process counter. */
export function testUuid(): `${string}-${string}-${string}-${string}-${string}` {
  const hex = (uuidCounter++).toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}
