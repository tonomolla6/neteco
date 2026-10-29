import { ref, shallowRef, watch, onBeforeUnmount } from 'vue'
import { supportReceiptSchema, type SupportReceipt } from '~~/shared/support-operations'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
type Upload = { file: File; expectedVersion: number; visibility: 'public' | 'internal' }
type Intent = {
  owner: string
  ref: string | null
  version: number | null
  key: string
  body: Record<string, unknown> | Upload
  upload: boolean
}
function errorCode(context: unknown) {
  try {
    const owned = catalogPolicyOwnJson(context)
    if (!owned || typeof owned !== 'object' || Array.isArray(owned)) return null
    const response = Reflect.get(owned, 'response')
    const data = response && typeof response === 'object' ? Reflect.get(response, '_data') : null
    const error = data && typeof data === 'object' ? Reflect.get(data, 'error') : null
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}
// Read only bounded own data from fetch error context; Response is a host
// object and must not be traversed by the generic JSON owner.
function responseCode(context: unknown) {
  try {
    if (!context || typeof context !== 'object') return null
    const descriptor = Object.getOwnPropertyDescriptor(context, 'response')
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.value) return null
    const data = Object.getOwnPropertyDescriptor(descriptor.value, '_data')
    return data && Object.hasOwn(data, 'value') ? errorCode({ response: { _data: data.value } }) : null
  } catch {
    return null
  }
}
export function useSupportCommand<T>(options: {
  owner: () => string | null
  runtime: () => unknown
  authorize: () => boolean
  reload: () => Promise<unknown>
  decode: (raw: unknown) => T | null
  facts: (value: T) => { ref: string | null; version: number | null; allowed: boolean }
  endpoint: (ref: string | null, upload: boolean) => string
  method: 'POST' | 'PUT'
  fetch: (
    endpoint: string,
    options: {
      method: 'POST' | 'PUT'
      body: Record<string, unknown> | FormData
      headers: Record<string, string>
      retry: 0
      onResponseError: (context: unknown) => void
    }
  ) => Promise<unknown>
  confirmed: (receipt: SupportReceipt) => void
  pending: (value: boolean) => void
}) {
  const intent = shallowRef<Readonly<Intent> | null>(null),
    busy = ref(false),
    ambiguous = ref(false),
    message = ref(''),
    contextCurrent = ref(true)
  let active = true,
    generation = 0
  const authorize = () => {
    try {
      return active && options.runtime() === 'cloudflare' && options.authorize() === true && options.owner() !== null
    } catch {
      return false
    }
  }
  watch(
    intent,
    (value) => {
      if (active) options.pending(value !== null)
    },
    { flush: 'sync' }
  )
  watch(
    () => [options.owner(), options.runtime(), authorize()],
    () => {
      generation++
      contextCurrent.value = false
      if (intent.value && (intent.value.owner !== options.owner() || options.runtime() !== 'cloudflare')) {
        intent.value = null
        ambiguous.value = false
        message.value = ''
      }
    },
    { flush: 'sync' }
  )
  function prepare(body: Record<string, unknown> | Upload, view: T, upload = false) {
    if (!authorize() || busy.value || intent.value) return false
    const facts = options.facts(view),
      owner = options.owner()
    if (!facts.allowed || owner === null) return false
    const frozen = upload
      ? Object.freeze({ ...body })
      : Object.freeze(catalogPolicyOwnJson(body) as Record<string, unknown>)
    intent.value = Object.freeze({
      owner,
      ref: facts.ref,
      version: facts.version,
      key: crypto.randomUUID(),
      body: frozen,
      upload
    })
    ambiguous.value = false
    message.value = ''
    return true
  }
  async function dispatch(recovery = false) {
    const pending = intent.value
    if (!pending || busy.value || !authorize() || pending.owner !== options.owner()) return
    busy.value = true
    message.value = ''
    const epoch = generation,
      current = () => active && generation === epoch && authorize() && pending.owner === options.owner()
    let sent = false,
      code: string | null = null
    try {
      const fresh = options.decode(await options.reload())
      if (!current()) return
      if (!fresh) throw new Error('support_context_unconfirmed')
      const facts = options.facts(fresh)
      if (facts.ref !== pending.ref) throw new Error('support_context_unconfirmed')
      if (!recovery && (!facts.allowed || facts.version !== pending.version)) {
        intent.value = null
        ambiguous.value = false
        contextCurrent.value = false
        message.value = 'El contexto ha cambiado. Actualiza antes de preparar otra acción.'
        return
      }
      let body: Record<string, unknown> | FormData = pending.body
      if (pending.upload) {
        const upload = pending.body as Upload,
          form = new FormData()
        form.set('file', upload.file)
        form.set('expectedVersion', String(upload.expectedVersion))
        form.set('visibility', upload.visibility)
        body = form
      }
      sent = true
      ambiguous.value = true
      const raw = await options.fetch(options.endpoint(pending.ref, pending.upload), {
        method: pending.upload ? 'POST' : options.method,
        body,
        headers: { 'Idempotency-Key': pending.key },
        retry: 0,
        onResponseError(context) {
          code = responseCode(context)
        }
      })
      if (!current()) return
      const receipt = supportReceiptSchema.safeParse(raw)
      if (
        !receipt.success ||
        (pending.ref !== null && receipt.data.publicRef !== pending.ref) ||
        receipt.data.version !== (pending.version === null ? 1 : pending.version + 1)
      )
        throw new Error('support_receipt_unconfirmed')
      intent.value = null
      ambiguous.value = false
      contextCurrent.value = false
      message.value =
        'Acción registrada: ' +
        receipt.data.publicRef +
        '. ' +
        (receipt.data.emailStatus === 'queued'
          ? 'Aviso en cola; no confirma entrega.'
          : 'Sin envío de correo solicitado.')
      options.confirmed(receipt.data)
      try {
        const latest = options.decode(await options.reload())
        if (!current()) return
        if (
          !latest ||
          (pending.ref !== null &&
            (options.facts(latest).ref !== pending.ref || (options.facts(latest).version ?? 0) < receipt.data.version))
        )
          throw new Error('support_read_unconfirmed')
        contextCurrent.value = true
      } catch {
        if (current()) message.value += ' El recibo es histórico; el estado actual no se ha confirmado.'
      }
    } catch {
      if (!current()) return
      contextCurrent.value = false
      if (
        sent &&
        !recovery &&
        code !== null &&
        [
          'invalid_input',
          'invalid_file',
          'invalid_transition',
          'version_conflict',
          'idempotency_conflict',
          'owner_unavailable',
          'guest_verification_required',
          'challenge_required',
          'challenge_unavailable',
          'rate_limited'
        ].includes(code)
      ) {
        intent.value = null
        ambiguous.value = false
        message.value =
          code === 'challenge_required'
            ? 'Se necesita un desafío verificado. Completa el mecanismo configurado antes de preparar un nuevo intento.'
            : code === 'challenge_unavailable'
              ? 'El verificador de desafío no está disponible. No se ha registrado la consulta.'
              : 'Acción rechazada de forma confirmada. Actualiza el contexto antes de preparar otra.'
      } else {
        ambiguous.value = sent || recovery
        message.value = ambiguous.value
          ? 'Resultado no confirmado. Recupera manualmente el mismo contenido y clave para evitar duplicados.'
          : 'Contexto no confirmado: no se ha enviado ninguna acción.'
      }
    } finally {
      if (active) busy.value = false
    }
  }
  function cancel() {
    if (!busy.value && !ambiguous.value) {
      intent.value = null
      message.value = 'Intento no enviado cancelado.'
    }
  }
  function confirmedContext() {
    contextCurrent.value = true
  }
  onBeforeUnmount(() => {
    active = false
    generation++
  })
  return { intent, busy, ambiguous, message, contextCurrent, authorize, prepare, dispatch, cancel, confirmedContext }
}
