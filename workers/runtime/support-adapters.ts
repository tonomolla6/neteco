import { z } from 'zod'
import { canonicalAddress } from '../auth/edge-limit'
import { supportScanReceiptSchema, type SupportScanReceiptVerifier } from '../support/attachments'
import type { SupportHttpDependencies } from '../support/http'

/** Dedicated audience and secret: catalogue scanner approval cannot approve
 * private customer-support attachments, even for identical bytes. */
export const SUPPORT_SCAN_AUDIENCE = 'neteco:support-attachment:scan:v1\n'
export function createSupportScanVerifier(secret: unknown): SupportScanReceiptVerifier | undefined {
  if (typeof secret !== 'string' || secret.startsWith('local-only-')) return undefined
  const bytes = new TextEncoder().encode(secret)
  if (bytes.length < 32 || bytes.length > 4096) return undefined
  return async (request, _body, rawBody) => {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/support/attachments/scan-receipts')
      return null
    if (typeof rawBody !== 'string' || !rawBody || new TextEncoder().encode(rawBody).length > 16384) return null
    const signature = /^sha256=([0-9a-f]{64})$/.exec(request.headers.get('x-neteco-support-scan-signature') ?? '')
    if (!signature) return null
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        key,
        Uint8Array.from(signature[1]!.match(/../g)!, (value) => Number.parseInt(value, 16)),
        new TextEncoder().encode(SUPPORT_SCAN_AUDIENCE + rawBody)
      ))
    )
      return null
    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      return null
    }
    const parsed = supportScanReceiptSchema.safeParse(body)
    return parsed.success ? parsed.data : null
  }
}

/** Official Siteverify port, no implicit network access, retry or log of tokens.
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ */
export function createSupportChallengeVerifier(
  secret: unknown,
  origin: string,
  fetcher: typeof fetch
): SupportHttpDependencies['challengeVerifier'] {
  if (
    typeof secret !== 'string' ||
    !/^[A-Za-z0-9_-]{20,1000}$/.test(secret) ||
    /^[123]x0+/.test(secret) ||
    secret.startsWith('local-only-')
  )
    return undefined
  let publicUrl: URL
  try {
    publicUrl = new URL(origin)
  } catch {
    return undefined
  }
  if (
    publicUrl.protocol !== 'https:' ||
    publicUrl.origin !== origin ||
    /\.(?:test|invalid)$/.test(publicUrl.hostname) ||
    typeof fetcher !== 'function'
  )
    return undefined
  return async ({ token, request }) => {
    if (typeof token !== 'string' || !token || token.length > 2048 || new URL(request.url).origin !== origin)
      return false
    const address = canonicalAddress(request.headers.get('cf-connecting-ip'))
    if (!address) return false
    try {
      const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ secret, response: token, remoteip: address })
      })
      if (!response.ok || !/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel().catch(() => undefined)
        return false
      }
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 8192)) {
        await response.body?.cancel().catch(() => undefined)
        return false
      }
      if (!response.body) return false
      const reader = response.body.getReader(),
        bytes = new Uint8Array(8192)
      let size = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          if (part.value.length > bytes.length - size) {
            await reader.cancel().catch(() => undefined)
            return false
          }
          bytes.set(part.value, size)
          size += part.value.length
        }
      } finally {
        reader.releaseLock()
      }
      const result = z
        .object({
          success: z.literal(true),
          hostname: z.literal(publicUrl.hostname),
          action: z.literal('neteco_support'),
          challenge_ts: z.string().datetime()
        })
        .passthrough()
        .safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))))
      if (!result.success) return false
      const age = Date.now() - Date.parse(result.data.challenge_ts)
      return age >= -5000 && age <= 300000
    } catch {
      return false
    }
  }
}
