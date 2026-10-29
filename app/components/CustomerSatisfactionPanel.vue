<script setup lang="ts">
import {
  customerSatisfactionSchema,
  satisfactionInputSchema,
  satisfactionReceiptSchema,
  satisfactionCommandResponseSchema,
  satisfactionIntentHash,
  type CustomerSatisfaction,
  type SatisfactionInput,
  type SatisfactionReceipt,
  type SatisfactionSource
} from '~~/shared/support-satisfaction'
const props = defineProps<{
  kind: SatisfactionSource
  targetId: string
  scopeKey: string
  enabled: boolean
  pending: boolean
}>()
const emit = defineEmits<{ pending: [value: boolean]; confirmed: [receipt: SatisfactionReceipt] }>()
const snapshot = shallowRef<CustomerSatisfaction | null>(null)
const loading = ref(false),
  failed = ref(false),
  busy = ref(false),
  uncertain = ref(false)
const score = ref(''),
  comment = ref(''),
  privacyAcknowledged = ref(false),
  message = ref('')
type Intent = Readonly<{ key: string; hash: string; body: Readonly<SatisfactionInput> }>
const intent = shallowRef<Intent | null>(null)
let active = true,
  generation = 0
const controllers = new Set<AbortController>()
const endpoint = () => `/api/account/satisfaction/${props.kind}/${encodeURIComponent(props.targetId)}`
const authorized = () => active && props.enabled && !!props.scopeKey
const current = (epoch: number) => authorized() && generation === epoch
const reasons = {
  source_not_final: 'El servicio todavía no está confirmado como finalizado.',
  policy_unavailable: 'La política de privacidad de esta valoración no está disponible.',
  retention_expired: 'Ha terminado el plazo operativo de esta valoración.',
  already_submitted: 'Ya has enviado una valoración para este servicio.'
}
const labels = ['Muy insatisfecho', 'Insatisfecho', 'Ni satisfecho ni insatisfecho', 'Satisfecho', 'Muy satisfecho']
function purge() {
  generation++
  for (const controller of controllers) controller.abort()
  controllers.clear()
  snapshot.value = null
  intent.value = null
  score.value = comment.value = message.value = ''
  privacyAcknowledged.value = loading.value = failed.value = busy.value = uncertain.value = false
}
async function request(path: string, options: Record<string, unknown> = {}) {
  const controller = new AbortController()
  controllers.add(controller)
  try {
    return await $fetch<unknown>(path, { ...options, retry: 0, cache: 'no-store', signal: controller.signal })
  } finally {
    controllers.delete(controller)
  }
}
async function state(epoch: number) {
  const parsed = customerSatisfactionSchema.safeParse(await request(endpoint()))
  if (
    !current(epoch) ||
    !parsed.success ||
    parsed.data.target.kind !== props.kind ||
    parsed.data.target.id !== props.targetId
  )
    throw new Error('unconfirmed_satisfaction')
  return parsed.data
}
function handleRejection(error: unknown, allowPolicyRejection = false) {
  const failure =
    error && typeof error === 'object'
      ? (error as {
          statusCode?: number
          status?: number
          data?: { error?: { code?: string } }
          response?: { status?: number; _data?: { error?: { code?: string } } }
        })
      : null
  const status = failure?.statusCode ?? failure?.status ?? failure?.response?.status
  if (status === 401 || status === 403) {
    purge()
    failed.value = true
    message.value =
      'Acceso no autorizado. Se han retirado los datos privados; no se enviará ninguna valoración automáticamente.'
    return true
  }
  const code = failure?.data?.error?.code ?? failure?.response?._data?.error?.code
  if (allowPolicyRejection && status === 409 && code === 'policy_version_conflict') {
    purge()
    failed.value = true
    message.value =
      'La política ha cambiado y este envío no se ha aplicado. Actualiza la valoración para leer la información vigente y decidir de nuevo.'
    return true
  }
  return false
}
async function read() {
  if (!authorized() || props.pending || loading.value || busy.value || intent.value) return
  const epoch = generation
  loading.value = true
  failed.value = false
  snapshot.value = null
  try {
    const result = await state(epoch)
    if (current(epoch)) snapshot.value = result
  } catch (error) {
    if (current(epoch) && !handleRejection(error)) failed.value = true
  } finally {
    if (current(epoch)) loading.value = false
  }
}
async function prepare() {
  if (!authorized() || props.pending || busy.value || loading.value || intent.value || !snapshot.value?.eligible) return
  const parsed = satisfactionInputSchema.safeParse({
    score: Number(score.value),
    ...(comment.value.trim() ? { comment: comment.value } : {}),
    privacyAcknowledged: privacyAcknowledged.value,
    expectedSourceVersion: snapshot.value.target.version,
    expectedPolicyHash: snapshot.value.privacy!.policyHash
  })
  if (!parsed.success) {
    message.value =
      'Elige una puntuación de 1 a 5, acepta la información de privacidad y limita el comentario a 1000 caracteres.'
    return
  }
  const epoch = generation
  busy.value = true
  message.value = ''
  try {
    const hash = await satisfactionIntentHash(props.kind, props.targetId, parsed.data)
    if (current(epoch) && !props.pending)
      intent.value = Object.freeze({ key: crypto.randomUUID(), hash, body: Object.freeze(parsed.data) })
  } catch {
    if (current(epoch)) message.value = 'No se ha podido preparar la valoración. No se ha enviado nada.'
  } finally {
    if (current(epoch)) busy.value = false
  }
}
function receipt(raw: unknown, command: Intent) {
  const parsed = satisfactionReceiptSchema.safeParse(raw)
  if (
    !parsed.success ||
    parsed.data.commandId !== command.key ||
    parsed.data.payloadHash !== command.hash ||
    parsed.data.target.kind !== props.kind ||
    parsed.data.target.id !== props.targetId ||
    parsed.data.target.version !== command.body.expectedSourceVersion ||
    parsed.data.score !== command.body.score
  )
    throw new Error('unconfirmed_satisfaction_receipt')
  return parsed.data
}
async function confirm(result: SatisfactionReceipt, command: Intent, epoch: number) {
  const fresh = await state(epoch)
  if (
    !fresh.feedback ||
    fresh.feedback.score !== command.body.score ||
    fresh.feedback.comment !== (command.body.comment ?? null) ||
    fresh.feedback.submittedAt !== result.submittedAt ||
    fresh.eligible ||
    fresh.reason !== 'already_submitted'
  )
    throw new Error('unconfirmed_satisfaction_state')
  if (!current(epoch) || intent.value !== command) return
  snapshot.value = fresh
  intent.value = null
  uncertain.value = false
  comment.value = score.value = ''
  privacyAcknowledged.value = false
  message.value = 'Valoración confirmada. No cambia la atención, el pedido ni tus derechos.'
  emit('confirmed', result)
}
async function send() {
  const command = intent.value
  if (!command || uncertain.value || !authorized() || props.pending || busy.value) return
  const epoch = generation
  busy.value = true
  uncertain.value = true
  message.value = ''
  let postResponded = false
  try {
    const raw = await request(endpoint(), {
      method: 'POST',
      headers: { 'Idempotency-Key': command.key },
      body: command.body
    })
    postResponded = true
    if (current(epoch) && intent.value === command) await confirm(receipt(raw, command), command, epoch)
  } catch (error) {
    if (current(epoch) && !handleRejection(error, !postResponded))
      message.value = 'Resultado no confirmado. Comprueba el recibo; no volveremos a enviar la valoración.'
  } finally {
    if (current(epoch)) busy.value = false
  }
}
async function recover() {
  const command = intent.value
  if (!command || !uncertain.value || !authorized() || props.pending || busy.value) return
  const epoch = generation
  busy.value = true
  try {
    const raw = await request(endpoint() + '/commands/' + command.key, {
      headers: { 'X-Neteco-Command-Payload-Hash': command.hash }
    })
    if (!current(epoch) || intent.value !== command) return
    const parsed = satisfactionCommandResponseSchema.safeParse(raw)
    if (!parsed.success || parsed.data.outcome !== 'applied') throw new Error('unknown_satisfaction')
    await confirm(receipt(parsed.data.receipt, command), command, epoch)
  } catch (error) {
    if (current(epoch) && !handleRejection(error))
      message.value =
        'El resultado sigue sin confirmarse. Desconocido no significa que no se aplicara; no se repetirá el envío.'
  } finally {
    if (current(epoch)) busy.value = false
  }
}
watch(
  intent,
  (value) => {
    if (active) emit('pending', value !== null)
  },
  { flush: 'sync' }
)
watch(
  () => [props.kind, props.targetId, props.scopeKey, props.enabled],
  () => {
    purge()
    if (authorized() && !props.pending) void read()
  },
  { immediate: true, flush: 'sync' }
)
watch(
  () => props.pending,
  (value) => {
    if (!value && authorized() && !snapshot.value && !failed.value) void read()
  }
)
onBeforeUnmount(() => {
  purge()
  active = false
  emit('pending', false)
})
</script>
<template>
  <section
    v-if="enabled"
    :aria-label="kind === 'support' ? 'Valoración opcional de soporte' : 'Valoración opcional de entrega'"
    class="min-w-0 space-y-3 rounded border p-4"
  >
    <h2 class="text-lg font-semibold">
      {{ kind === 'support' ? 'Valorar la atención recibida' : 'Valorar la entrega' }}
    </h2>
    <p>Participar es opcional. Tu puntuación no condiciona el servicio, la atención ni tus derechos.</p>
    <p v-if="loading" role="status">Confirmando si puedes valorar este servicio…</p>
    <p v-if="failed" role="alert">
      No se ha confirmado la valoración disponible. Un error no equivale a no haber valorado.
    </p>
    <button
      v-if="!intent"
      data-testid="satisfaction-refresh"
      :disabled="loading || busy || pending"
      class="rounded border p-2"
      @click="read"
    >
      Actualizar valoración
    </button>
    <template v-if="snapshot">
      <p v-if="snapshot.reason" role="status">{{ reasons[snapshot.reason] }}</p>
      <div v-if="snapshot.feedback" data-testid="satisfaction-saved" class="break-words">
        <p>Tu valoración: {{ snapshot.feedback.score }} de 5 · {{ snapshot.feedback.submittedAt }}</p>
        <p v-if="snapshot.feedback.comment">{{ snapshot.feedback.comment }}</p>
      </div>
      <form
        v-if="snapshot.eligible && !intent"
        data-testid="satisfaction-form"
        class="space-y-3"
        @submit.prevent="prepare"
      >
        <fieldset :disabled="busy || pending">
          <legend>¿Cómo valorarías este servicio?</legend>
          <label v-for="(label, index) in labels" :key="label" class="block"
            ><input v-model="score" type="radio" name="satisfaction-score" :value="String(index + 1)" />
            {{ index + 1 }} · {{ label }}</label
          >
        </fieldset>
        <label class="block"
          >Comentario opcional<textarea
            v-model="comment"
            data-testid="satisfaction-comment"
            maxlength="1000"
            :disabled="busy || pending"
            class="w-full rounded border p-2"
          />
        </label>
        <p>
          No incluyas datos personales sensibles ni información de otras personas. No es un canal urgente de soporte.
        </p>
        <p v-if="snapshot.privacy">
          Consulta disponible hasta {{ snapshot.privacy.retentionUntil }} ·
          <a :href="snapshot.privacy.noticePath" class="underline">Información de privacidad</a>
        </p>
        <label class="block"
          ><input
            v-model="privacyAcknowledged"
            data-testid="satisfaction-privacy"
            type="checkbox"
            :disabled="busy || pending"
          />
          He leído la información de privacidad para esta valoración.</label
        >
        <button :disabled="busy || pending" class="rounded border p-2">Revisar valoración</button>
      </form>
    </template>
    <div v-if="intent" class="space-y-2 rounded border p-3">
      <p>Valoración preparada: {{ intent.body.score }} de 5. Enviar es opcional.</p>
      <p v-if="intent.body.comment" class="break-words">{{ intent.body.comment }}</p>
      <button
        v-if="!uncertain"
        data-testid="satisfaction-confirm"
        :disabled="busy || pending"
        class="rounded border p-2"
        @click="send"
      >
        Confirmar envío de valoración
      </button>
      <button v-if="!uncertain" :disabled="busy || pending" class="rounded border p-2" @click="intent = null">
        Volver al borrador
      </button>
      <button
        v-else
        data-testid="satisfaction-recover"
        :disabled="busy || pending"
        class="rounded border p-2"
        @click="recover"
      >
        Comprobar recibo de valoración
      </button>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>
