export function privateCookieOptions(maxAge: number, environment = process.env.APP_ENV) {
  if (!Number.isSafeInteger(maxAge) || maxAge <= 0) throw new RangeError('Cookie maxAge must be a positive integer')
  return {
    httpOnly: true,
    secure: environment === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge
  }
}
