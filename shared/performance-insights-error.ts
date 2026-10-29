/** Stable, HTTP-mappable error for OBS-030 / PER-022 / PER-023 / PER-025 modules. */
export class PerformanceInsightError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number = 400,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'PerformanceInsightError'
  }
}

/** Canonical timestamp accepted by D1 CHECK constraints: YYYY-MM-DDTHH:MM:SSZ. */
export const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

export function isCanonicalInstant(value: string): boolean {
  if (!CANONICAL_INSTANT.test(value)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z') === value
}
