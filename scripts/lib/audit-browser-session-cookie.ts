/** Correlate one sealed session without changing the original forwarded Cookie header. */
export function sealedSessionCookie(cookie: string | null): string | null {
  if (!cookie || cookie.length > 16384 || /[\r\n]/.test(cookie)) return null
  const sessions = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf('=')
      return (separator < 0 ? part : part.slice(0, separator)).trim() === 'neteco-session'
    })
  if (sessions.length !== 1 || !/^neteco-session=[^\s;]+$/.test(sessions[0]!)) return null
  return sessions[0]!
}
