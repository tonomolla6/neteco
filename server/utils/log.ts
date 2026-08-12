const secretKeys = /authorization|cookie|password|secret|token|pan|card|cvc|nif|email|phone|address/i

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, secretKeys.test(key) ? '[REDACTED]' : redact(entry)])
  )
}

export function structuredLog(level: LogLevel, event: string, context: Record<string, unknown> = {}) {
  const safeContext = redact(context) as Record<string, unknown>
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: 'neteco',
    environment: process.env.APP_ENV ?? 'local',
    version: process.env.APP_VERSION ?? 'dev',
    ...safeContext
  }
  process.stdout.write(`${JSON.stringify(record)}\n`)
}
