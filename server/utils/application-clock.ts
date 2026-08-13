export function applicationNow(environment: NodeJS.ProcessEnv = process.env) {
  const fixed = environment.APP_ENV === 'test' ? environment.NETECO_TEST_NOW?.trim() : ''
  if (!fixed) return new Date()
  const timestamp = Date.parse(fixed)
  if (Number.isNaN(timestamp)) throw new Error('NETECO_TEST_NOW must be a valid ISO timestamp')
  return new Date(timestamp)
}
