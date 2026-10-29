/** Identify SQLite CHECK failures, not provider errors that merely mention CHECK.
 * Both native SQLite and D1's wrapped format may include a multiline SQL check.
 */
export function isD1CheckConstraintFailure(error: unknown): boolean {
  try {
    if (!(error instanceof Error)) return false
    const message: unknown = Object.getOwnPropertyDescriptor(error, 'message')?.value
    if (typeof message !== 'string') return false

    const nativePrefix = 'CHECK constraint failed: '
    const d1Prefix = `D1_ERROR: ${nativePrefix}`
    const d1Suffixes = [': SQLITE_CONSTRAINT', ': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)']
    let constraint: string
    if (message.startsWith(nativePrefix)) constraint = message.slice(nativePrefix.length)
    else {
      const suffix = d1Suffixes.find((candidate) => message.endsWith(candidate))
      if (!message.startsWith(d1Prefix) || !suffix) return false
      constraint = message.slice(d1Prefix.length, -suffix.length)
    }

    if (constraint.trim().length === 0) return false
    for (let index = 0; index < constraint.length; index += 1) {
      const code = constraint.charCodeAt(index)
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return false
    }
    return true
  } catch {
    // Hostile objects/accessors are not database evidence.
    return false
  }
}
