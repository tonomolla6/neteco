import { z } from 'zod'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { fiscalUuid, fiscalHash, fiscalInstant } from '../../shared/fiscal-issuance'
import {
  refundMappingsSchema,
  refundPolicyInputSchema,
  refundCardCents,
  refundContractSchema,
  refundReceiptSchema,
  type RefundPolicy,
  type RefundContract,
  type RefundReceipt,
  type GovernedRefundProvider
} from '../../shared/order-refunds'
import {
  REDSYS_SIGNATURE_VERSION,
  decodeMerchantParameters,
  encodeMerchantParameters,
  signMerchantParameters,
  verifyMerchantSignature,
  sha256Hex,
  type RedsysConfiguration
} from '../payments/redsys'
import { hash } from './authority'

/** Fixed authorities documented for refund operation 3; no configurable URL.
 * https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-operativa/devolver-o-anular-un-pago/
 * https://pagosonline.redsys.es/desarrolladores-inicio/integrate-con-nosotros/parametros-de-entrada-y-salida/
 * https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-operativa/firmar-una-operacion/
 * Public protocol checked 2026-10-03, NOT bank/merchant acceptance testing. */
const endpoints = {
  sandbox: 'https://sis-t.redsys.es:25443/sis/rest/trataPeticionREST',
  production: 'https://sis.redsys.es/sis/rest/trataPeticionREST'
} as const
const maximumResponseBytes = 32768
const configurationSchema = z
  .object({
    appEnvironment: z.enum(['preview', 'production']),
    environment: z.enum(['sandbox', 'production']),
    merchantCode: z.string().regex(/^\d{9}$/),
    terminal: refundMappingsSchema.shape.terminal,
    currency: z.literal('978'),
    secretKey: z
      .string()
      .min(1)
      .max(1000)
      .regex(/^[\x20-\x7e]+$/),
    timeoutMs: z.number().int().min(1000).max(60000).optional()
  })
  .strict()
  .refine((value) => (value.appEnvironment === 'production') === (value.environment === 'production'))
export type WorkerRedsysRefundConfiguration = Pick<
  RedsysConfiguration,
  'environment' | 'merchantCode' | 'terminal' | 'secretKey'
> & {
  appEnvironment: 'preview' | 'production'
  currency: '978'
  timeoutMs?: number
}
type ErrorCode = 'configuration' | 'policy' | 'request' | 'outcome_unconfirmed'
export class WorkerRedsysRefundError extends Error {
  readonly possibleAcceptance: boolean
  constructor(readonly code: ErrorCode) {
    super(`redsys_refund_${code}`)
    this.name = 'WorkerRedsysRefundError'
    this.possibleAcceptance = code === 'outcome_unconfirmed'
  }
}
function validated<T>(schema: { parse(value: unknown): T }, value: unknown, code: ErrorCode): T {
  try {
    return schema.parse(catalogPolicyOwnJson(value))
  } catch {
    // Never propagate Zod/raw response errors, configuration or credentials.
    throw new WorkerRedsysRefundError(code)
  }
}
async function approvedPolicy(raw: RefundPolicy): Promise<RefundPolicy> {
  const metadata = validated(
      z.object({ id: fiscalUuid, fingerprint: fiscalHash, approvedAt: fiscalInstant }).passthrough(),
      raw,
      'policy'
    ),
    { id, fingerprint, approvedAt, ...values } = metadata,
    input = validated(refundPolicyInputSchema, values, 'policy')
  if (input.provider !== 'redsys' || (await hash({ scope: 'refund', input })) !== fingerprint)
    throw new WorkerRedsysRefundError('policy')
  return Object.freeze({ ...input, mappings: Object.freeze(input.mappings), id, fingerprint, approvedAt })
}

/** REST envelopes/merchant parameters are flat JSON string dictionaries, as in
 * the maintained payment adapter. Parse before JSON.parse can erase duplicate
 * names; case aliases and escaped duplicate keys are equally ambiguous. Unknown
 * STRING response fields (e.g. Ds_Control_*) remain forward-compatible. */
function stringDictionary(text: string): Record<string, string> {
  let offset = 0
  const output: Record<string, string> = Object.create(null)
  const skip = () => {
    while (offset < text.length && /[\x20\t\r\n]/.test(text[offset]!)) offset++
  }
  const string = () => {
    skip()
    const start = offset
    if (text[offset++] !== '"') throw new WorkerRedsysRefundError('outcome_unconfirmed')
    while (offset < text.length) {
      const char = text[offset++]
      if (char === '\\') offset++
      else if (char === '"') return JSON.parse(text.slice(start, offset)) as string
    }
    throw new WorkerRedsysRefundError('outcome_unconfirmed')
  }
  skip()
  if (text[offset++] !== '{') throw new WorkerRedsysRefundError('outcome_unconfirmed')
  skip()
  let fields = 0
  if (text[offset] !== '}') {
    while (true) {
      const name = string().toUpperCase()
      if (++fields > 128 || name.length > 100 || Object.hasOwn(output, name))
        throw new WorkerRedsysRefundError('outcome_unconfirmed')
      skip()
      if (text[offset++] !== ':') throw new WorkerRedsysRefundError('outcome_unconfirmed')
      const value = string()
      if (value.length > 16384 || ['__PROTO__', 'CONSTRUCTOR', 'PROTOTYPE'].includes(name))
        throw new WorkerRedsysRefundError('outcome_unconfirmed')
      output[name] = value
      skip()
      if (text[offset] === '}') break
      if (text[offset++] !== ',') throw new WorkerRedsysRefundError('outcome_unconfirmed')
    }
  }
  if (text[offset++] !== '}') throw new WorkerRedsysRefundError('outcome_unconfirmed')
  skip()
  if (offset !== text.length) throw new WorkerRedsysRefundError('outcome_unconfirmed')
  return output
}
function merchantDictionary(encoded: string): Record<string, string> {
  // Reuse canonical Base64URL/UTF-8/string-value validation and maintained
  // signing implementation, with the extra duplicate-member JSON boundary.
  decodeMerchantParameters(encoded)
  const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/'),
    binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')),
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return stringDictionary(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new WorkerRedsysRefundError('outcome_unconfirmed'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new WorkerRedsysRefundError('outcome_unconfirmed'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
async function boundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get('content-length')
  if ((length !== null && (!/^\d+$/.test(length) || Number(length) > maximumResponseBytes)) || !response.body)
    throw new WorkerRedsysRefundError('outcome_unconfirmed')
  const reader = response.body.getReader(),
    bytes = new Uint8Array(maximumResponseBytes)
  let size = 0
  try {
    while (true) {
      const part = await abortable(reader.read(), signal)
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > maximumResponseBytes - size)
        throw new WorkerRedsysRefundError('outcome_unconfirmed')
      bytes.set(part.value, size)
      size += part.value.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
  } catch {
    void reader.cancel().catch(() => {})
    throw new WorkerRedsysRefundError('outcome_unconfirmed')
  } finally {
    reader.releaseLock()
  }
}

/** No default fetch, env access, automatic retries or external-key lookup.
 * Creation validates a SERVER-OWNED approved policy snapshot, not a legal grant:
 * the D1 executor still owns current authorization, policy withdrawal, capture
 * proof, cumulative reservation and the durable PRE-provider submission marker.
 * Call ONLY through that executor; a signed merchant-data echo is correlation,
 * not bank-side idempotency. An uncertain result must never call refund again.
 * Sandbox success proves a sandbox operation, not production fund movement. */
export class WorkerRedsysRefundProvider implements GovernedRefundProvider {
  readonly name = 'redsys' as const
  readonly environment: 'sandbox' | 'production'
  readonly policyId: string
  readonly policyFingerprint: string
  readonly #configuration: z.infer<typeof configurationSchema>
  readonly #policy: RefundPolicy
  readonly #fetcher: typeof fetch
  private constructor(
    configuration: z.infer<typeof configurationSchema>,
    policy: RefundPolicy,
    fetcher: typeof fetch,
    readonly mappingFingerprint: string
  ) {
    this.#configuration = Object.freeze(configuration)
    this.#policy = policy
    this.#fetcher = fetcher
    this.environment = configuration.environment
    this.policyId = policy.id
    this.policyFingerprint = policy.fingerprint
    Object.freeze(this)
  }
  static async create(
    raw: WorkerRedsysRefundConfiguration,
    rawPolicy: RefundPolicy,
    fetcher: typeof fetch
  ): Promise<WorkerRedsysRefundProvider> {
    const configuration = validated(configurationSchema, raw, 'configuration')
    if (typeof fetcher !== 'function') throw new WorkerRedsysRefundError('configuration')
    const policy = await approvedPolicy(rawPolicy),
      mappings = {
        merchantCode: configuration.merchantCode,
        terminal: configuration.terminal,
        currencyCode: configuration.currency
      },
      mappingFingerprint = await hash(mappings)
    if (policy.environment !== configuration.environment || (await hash(policy.mappings)) !== mappingFingerprint)
      throw new WorkerRedsysRefundError('policy')
    return new WorkerRedsysRefundProvider(configuration, policy, fetcher, mappingFingerprint)
  }
  async refund(raw: RefundContract): Promise<RefundReceipt> {
    const contract = validated(refundContractSchema, raw, 'request'),
      configuration = this.#configuration,
      policy = this.#policy
    if (
      contract.provider !== 'redsys' ||
      contract.validationOnly ||
      contract.environment !== configuration.environment ||
      contract.capture.environment !== configuration.environment ||
      contract.policyId !== policy.id ||
      contract.policyFingerprint !== policy.fingerprint ||
      (await hash(contract.capture.mappings)) !== this.mappingFingerprint ||
      contract.amountCents > policy.maximumRefundCents ||
      // PRI-018: only the card share goes to Redsys; a store-credit-only refund never reaches it.
      refundCardCents(contract) < 1 ||
      (policy.shipping === 'excluded' && contract.components.some((component) => component.component === 'shipping'))
    )
      throw new WorkerRedsysRefundError('request')
    const order = contract.capture.merchantOrder,
      originalReference = contract.capture.providerReference,
      authorization = originalReference === null ? null : originalReference.slice(order.length + 1)
    if (
      originalReference !== null &&
      (originalReference !== `${order}:${authorization}` || !/^[A-Za-z0-9]{6}$/.test(authorization!))
    )
      throw new WorkerRedsysRefundError('request')
    const fingerprint = await hash(contract),
      correlation = `NRF1${fingerprint}`,
      parameters = encodeMerchantParameters({
        DS_MERCHANT_ORDER: order,
        DS_MERCHANT_MERCHANTCODE: configuration.merchantCode,
        DS_MERCHANT_TERMINAL: configuration.terminal,
        DS_MERCHANT_TRANSACTIONTYPE: '3',
        DS_MERCHANT_CURRENCY: configuration.currency,
        DS_MERCHANT_AMOUNT: String(refundCardCents(contract)),
        DS_MERCHANT_MERCHANTDATA: correlation,
        ...(authorization ? { DS_MERCHANT_AUTHORISATIONCODE: authorization } : {})
      }),
      envelope = {
        Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION,
        Ds_MerchantParameters: parameters,
        Ds_Signature: await signMerchantParameters(parameters, configuration.secretKey, order)
      },
      controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), configuration.timeoutMs ?? 10000),
      endpoint = endpoints[configuration.environment]
    let response: Response | undefined
    try {
      const operation = this.#fetcher(endpoint, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(envelope)
      }).then((value) => {
        if (controller.signal.aborted) {
          void value.body?.cancel().catch(() => {})
          throw new WorkerRedsysRefundError('outcome_unconfirmed')
        }
        return value
      })
      response = await abortable(operation, controller.signal)
      if (
        !(response instanceof Response) ||
        !response.ok ||
        response.redirected ||
        (response.url !== '' && response.url !== endpoint) ||
        !/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '')
      )
        throw new WorkerRedsysRefundError('outcome_unconfirmed')
      const result = stringDictionary(await boundedResponse(response, controller.signal))
      if (
        Object.keys(result).length !== 3 ||
        result.DS_SIGNATUREVERSION !== REDSYS_SIGNATURE_VERSION ||
        !result.DS_MERCHANTPARAMETERS ||
        !result.DS_SIGNATURE
      )
        throw new WorkerRedsysRefundError('outcome_unconfirmed')
      const received = merchantDictionary(result.DS_MERCHANTPARAMETERS)
      if (
        !(await verifyMerchantSignature(result.DS_MERCHANTPARAMETERS, result.DS_SIGNATURE, configuration.secretKey)) ||
        controller.signal.aborted ||
        received.DS_ORDER !== order ||
        !/^\d{1,12}$/.test(received.DS_AMOUNT ?? '') ||
        Number(received.DS_AMOUNT) !== refundCardCents(contract) ||
        received.DS_CURRENCY !== configuration.currency ||
        received.DS_MERCHANTCODE !== configuration.merchantCode ||
        !/^\d{1,3}$/.test(received.DS_TERMINAL ?? '') ||
        Number(received.DS_TERMINAL) !== Number(configuration.terminal) ||
        // The refund tutorial's type-2 response example conflicts with the
        // parameter table (response echoes request type). Never weaken this to
        // accept a preauthorization confirmation or a cancellation as refund.
        received.DS_TRANSACTIONTYPE !== '3' ||
        received.DS_RESPONSE !== '0900' ||
        received.DS_MERCHANTDATA !== correlation
      )
        throw new WorkerRedsysRefundError('outcome_unconfirmed')
      // A local proof-address for this verified response, NOT a bank-assigned
      // refund identifier, external-key lookup promise or settlement proof.
      return validated(
        refundReceiptSchema,
        {
          providerReference: `redsys-refund:${await sha256Hex(result.DS_MERCHANTPARAMETERS)}`,
          status: 'succeeded',
          amountCents: refundCardCents(contract),
          currency: contract.currency,
          merchantOrder: order,
          contractFingerprint: fingerprint,
          validationOnly: false
        },
        'outcome_unconfirmed'
      )
    } catch {
      void response?.body?.cancel().catch(() => {})
      throw new WorkerRedsysRefundError('outcome_unconfirmed')
    } finally {
      clearTimeout(timer)
    }
  }
}
