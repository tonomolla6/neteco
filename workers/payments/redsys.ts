/** Worker-native Redsys Redirect integration (HMAC_SHA512_V2).
 *
 * Uses only Web Crypto and web platform primitives. Card credentials remain on
 * Redsys-hosted pages; this module never accepts PAN, expiry date or CVC.
 */

export const REDSYS_SIGNATURE_VERSION = 'HMAC_SHA512_V2'
export const REDSYS_REDIRECT_URLS = {
  sandbox: 'https://sis-t.redsys.es:25443/sis/realizarPago',
  production: 'https://sis.redsys.es/sis/realizarPago'
} as const

const ORDER_PATTERN = /^[A-Za-z0-9]{4,12}$/
const MERCHANT_CODE_PATTERN = /^\d{9}$/
const TERMINAL_PATTERN = /^\d{1,3}$/
const ENVELOPE_VALUE_LIMIT = 16_384

export type RedsysEnvironment = keyof typeof REDSYS_REDIRECT_URLS
export type RedsysPaymentMethod = 'card' | 'bizum'

export interface RedsysConfiguration {
  environment: RedsysEnvironment
  merchantCode: string
  terminal: string
  secretKey: string
  merchantName: string
  currency?: '978'
  bizumEnabled?: boolean
}

export interface RedsysRedirectInput {
  merchantOrder: string
  amountCents: number
  method: RedsysPaymentMethod
  notificationUrl: string
  returnUrl: string
  expiresAt: string
}

export interface RedsysRedirect {
  provider: 'redsys'
  actionUrl: string
  method: 'POST'
  fields: {
    Ds_SignatureVersion: typeof REDSYS_SIGNATURE_VERSION
    Ds_MerchantParameters: string
    Ds_Signature: string
  }
  expiresAt: string
}

export interface RedsysNotification {
  providerEventId: string
  providerReference?: string
  merchantOrder: string
  amountCents: number
  currencyCode: string
  status: 'captured' | 'pending' | 'failed' | 'cancelled'
  responseCode: string
  payloadHash: string
}

export interface RedsysEnvelope {
  Ds_SignatureVersion: string
  Ds_MerchantParameters: string
  Ds_Signature: string
}

type RedsysParameters = Record<string, string>

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length > ENVELOPE_VALUE_LIMIT)
    throw new Error('Invalid Redsys base64url value')
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  const bytes = base64ToBytes(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='))
  if (base64UrlEncode(bytes) !== value.replace(/=+$/, '')) throw new Error('Invalid Redsys base64url value')
  return bytes
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer(utf8(value))))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function encodeMerchantParameters(parameters: Record<string, string>): string {
  return base64UrlEncode(utf8(JSON.stringify(parameters)))
}

export function decodeMerchantParameters(encoded: string): RedsysParameters {
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlDecode(encoded)))
  } catch {
    throw new Error('Invalid Redsys merchant parameters')
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
    throw new Error('Invalid Redsys merchant parameters')
  const entries: Array<[string, string]> = []
  const names = new Set<string>()
  for (const [key, value] of Object.entries(decoded)) {
    const name = key.toUpperCase()
    if (names.has(name) || typeof value !== 'string') throw new Error('Invalid Redsys merchant parameters')
    names.add(name)
    entries.push([name, value])
  }
  return Object.fromEntries(entries)
}

function assertMerchantOrder(value: string): string {
  if (!ORDER_PATTERN.test(value)) throw new Error('Invalid Redsys merchant order')
  return value
}

function operationSecret(secretKey: string): Uint8Array {
  if (!/^[\x20-\x7e]+$/.test(secretKey)) throw new Error('Redsys secret must use single-byte ASCII characters')
  return utf8(secretKey.slice(0, 16).padEnd(16, '0'))
}

export async function deriveOperationKey(secretKey: string, merchantOrder: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    arrayBuffer(operationSecret(secretKey)),
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  )
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: arrayBuffer(new Uint8Array(16)) },
      key,
      arrayBuffer(utf8(assertMerchantOrder(merchantOrder)))
    )
  )
}

export async function signMerchantParameters(
  merchantParameters: string,
  secretKey: string,
  merchantOrder?: string
): Promise<string> {
  const decoded = merchantOrder ? undefined : decodeMerchantParameters(merchantParameters)
  const order = merchantOrder ?? decoded?.DS_ORDER ?? decoded?.DS_MERCHANT_ORDER
  if (!order) throw new Error('Redsys order is missing')
  // Redsys V2 uses the Base64 representation of the AES-derived operation key
  // as the HMAC key (confirmed by its published reference vector).
  const derivedBase64 = bytesToBase64(await deriveOperationKey(secretKey, order))
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    arrayBuffer(utf8(derivedBase64)),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  )
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, arrayBuffer(utf8(merchantParameters))))
  )
}

export async function verifyMerchantSignature(
  merchantParameters: string,
  signature: string,
  secretKey: string
): Promise<boolean> {
  let expected: Uint8Array
  let actual: Uint8Array
  try {
    expected = base64UrlDecode(await signMerchantParameters(merchantParameters, secretKey))
    actual = base64UrlDecode(signature)
  } catch {
    return false
  }
  let difference = expected.length ^ actual.length
  const length = Math.max(expected.length, actual.length)
  for (let index = 0; index < length; index += 1) difference |= (expected[index] ?? 0) ^ (actual[index] ?? 0)
  return difference === 0
}

function normalizeConfiguration(configuration: RedsysConfiguration) {
  if (configuration.environment !== 'sandbox' && configuration.environment !== 'production')
    throw new Error('Invalid Redsys environment')
  if (configuration.currency !== undefined && configuration.currency !== '978')
    throw new Error('Redsys provider supports EUR only')
  if (!MERCHANT_CODE_PATTERN.test(configuration.merchantCode)) throw new Error('Invalid Redsys merchant code')
  if (!TERMINAL_PATTERN.test(configuration.terminal)) throw new Error('Invalid Redsys terminal')
  if (!configuration.secretKey) throw new Error('Missing Redsys secret')
  if (
    !configuration.merchantName ||
    configuration.merchantName.length > 25 ||
    [...configuration.merchantName].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error('Invalid Redsys merchant name')
  return {
    ...configuration,
    currency: configuration.currency ?? ('978' as const),
    terminal: configuration.terminal.padStart(3, '0')
  }
}

function assertHttpsUrl(value: string, name: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS`)
  return url.toString()
}

export async function createRedsysRedirect(
  configuration: RedsysConfiguration,
  input: RedsysRedirectInput
): Promise<RedsysRedirect> {
  const config = normalizeConfiguration(configuration)
  const merchantOrder = assertMerchantOrder(input.merchantOrder)
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0)
    throw new Error('Redsys amount must be a positive safe integer')
  if (input.method !== 'card' && input.method !== 'bizum') throw new Error('Unsupported payment method')
  if (input.method === 'bizum' && !config.bizumEnabled) throw new Error('Bizum is not enabled for this terminal')

  const returnUrl = new URL(assertHttpsUrl(input.returnUrl, 'returnUrl'))
  const failureUrl = new URL(returnUrl)
  returnUrl.searchParams.set('payment', 'returned')
  failureUrl.searchParams.set('payment', 'failed')
  const parameters: Record<string, string> = {
    DS_MERCHANT_AMOUNT: String(input.amountCents),
    DS_MERCHANT_ORDER: merchantOrder,
    DS_MERCHANT_MERCHANTCODE: config.merchantCode,
    DS_MERCHANT_CURRENCY: config.currency,
    DS_MERCHANT_TRANSACTIONTYPE: '0',
    DS_MERCHANT_TERMINAL: config.terminal,
    DS_MERCHANT_MERCHANTURL: assertHttpsUrl(input.notificationUrl, 'notificationUrl'),
    DS_MERCHANT_URLOK: returnUrl.toString(),
    DS_MERCHANT_URLKO: failureUrl.toString(),
    DS_MERCHANT_MERCHANTNAME: config.merchantName
  }
  if (input.method === 'bizum') parameters.DS_MERCHANT_PAYMETHODS = 'z'
  const merchantParameters = encodeMerchantParameters(parameters)
  return {
    actionUrl: REDSYS_REDIRECT_URLS[config.environment],
    expiresAt: input.expiresAt,
    fields: {
      Ds_MerchantParameters: merchantParameters,
      Ds_Signature: await signMerchantParameters(merchantParameters, config.secretKey, merchantOrder),
      Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION
    },
    method: 'POST',
    provider: 'redsys'
  }
}

function requiredParameter(parameters: RedsysParameters, name: string, pattern: RegExp): string {
  const value = parameters[name]
  if (!value || !pattern.test(value)) throw new Error(`Invalid Redsys ${name}`)
  return value
}

function notificationStatus(responseCode: string): RedsysNotification['status'] {
  const response = Number(responseCode)
  if (response >= 0 && response <= 99) return 'captured'
  if ([9997, 9998, 9999].includes(response)) return 'pending'
  if (response === 9915) return 'cancelled'
  return 'failed'
}

export async function verifyRedsysNotification(
  configuration: RedsysConfiguration,
  envelope: RedsysEnvelope
): Promise<RedsysNotification> {
  const config = normalizeConfiguration(configuration)
  if (envelope.Ds_SignatureVersion !== REDSYS_SIGNATURE_VERSION) throw new Error('Unsupported Redsys signature version')
  for (const value of [envelope.Ds_MerchantParameters, envelope.Ds_Signature])
    if (!value || value.length > ENVELOPE_VALUE_LIMIT) throw new Error('Invalid Redsys envelope')
  if (!(await verifyMerchantSignature(envelope.Ds_MerchantParameters, envelope.Ds_Signature, config.secretKey)))
    throw new Error('Invalid Redsys signature')

  const parameters = decodeMerchantParameters(envelope.Ds_MerchantParameters)
  const merchantOrder = requiredParameter(parameters, 'DS_ORDER', ORDER_PATTERN)
  const amount = requiredParameter(parameters, 'DS_AMOUNT', /^\d{1,12}$/)
  const currencyCode = requiredParameter(parameters, 'DS_CURRENCY', /^\d{3}$/)
  const response = requiredParameter(parameters, 'DS_RESPONSE', /^\d{1,4}$/).padStart(4, '0')
  const merchantCode = requiredParameter(parameters, 'DS_MERCHANTCODE', MERCHANT_CODE_PATTERN)
  const terminal = requiredParameter(parameters, 'DS_TERMINAL', TERMINAL_PATTERN).padStart(3, '0')
  if (
    merchantCode !== config.merchantCode ||
    terminal !== config.terminal ||
    currencyCode !== config.currency ||
    parameters.DS_TRANSACTIONTYPE !== '0'
  )
    throw new Error('Redsys notification does not match the configured terminal')
  const amountCents = Number(amount)
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('Invalid Redsys amount')
  const payloadHash = await sha256Hex(envelope.Ds_MerchantParameters)
  const providerReference = parameters.DS_AUTHORISATIONCODE
    ? `${merchantOrder}:${parameters.DS_AUTHORISATIONCODE}`
    : undefined
  return {
    amountCents,
    currencyCode,
    merchantOrder,
    payloadHash,
    providerEventId: `${merchantOrder}:0:${payloadHash}`,
    providerReference,
    responseCode: response,
    status: notificationStatus(response)
  }
}
