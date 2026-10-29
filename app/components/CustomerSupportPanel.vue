<script setup lang="ts">
import {
  supportCustomerTicketSchema,
  supportCustomerReplySchema,
  supportUuid,
  type SupportCustomerTicket,
  type SupportReceipt
} from '~~/shared/support-operations'
import { useSupportCommand } from './support/commands'
import SupportTicketFacts from './support/SupportTicketFacts.vue'
const props = defineProps<{
  snapshot: unknown
  publicRef: string
  operatorId: string
  runtime: unknown
  authorize: () => boolean
  reload: () => Promise<unknown>
}>()
const emit = defineEmits<{ confirmed: [receipt: SupportReceipt]; pending: [value: boolean] }>()
const body = ref(''),
  file = shallowRef<File | null>(null),
  validation = ref('')
const decode = (raw: unknown): SupportCustomerTicket | null => {
  const value = supportCustomerTicketSchema.safeParse(raw)
  return value.success && value.data.publicRef === props.publicRef ? value.data : null
}
const command = useSupportCommand({
  owner: () => (supportUuid.safeParse(props.operatorId).success ? props.operatorId + ':' + props.publicRef : null),
  runtime: () => props.runtime,
  authorize: () => props.authorize(),
  reload: () => props.reload(),
  decode,
  facts: (value) => ({
    ref: value.publicRef,
    version: value.version,
    allowed: value.capabilities.reply || value.capabilities.attachments
  }),
  endpoint: (ref, upload) => '/api/account/support/' + ref + (upload ? '/attachments' : ''),
  method: 'POST',
  fetch: (endpoint, options) => $fetch<unknown>(endpoint, options),
  confirmed: (receipt) => {
    body.value = ''
    file.value = null
    emit('confirmed', receipt)
  },
  pending: (value) => emit('pending', value)
})
const { intent, busy, ambiguous, message, contextCurrent } = command
const view = computed(() => (command.authorize() && contextCurrent.value ? decode(props.snapshot) : null))
watch(
  () => props.snapshot,
  () => {
    if (command.authorize() && decode(props.snapshot)) command.confirmedContext()
  }
)
watch(
  () => [props.operatorId, props.publicRef],
  () => {
    body.value = ''
    file.value = null
    validation.value = ''
  }
)
function prepare() {
  const data = view.value
  if (!data?.capabilities.reply) return
  const parsed = supportCustomerReplySchema.safeParse({ expectedVersion: data.version, message: body.value.trim() })
  if (!parsed.success) {
    validation.value = 'Escribe una respuesta entre 1 y 5000 caracteres.'
    return
  }
  validation.value = ''
  command.prepare(parsed.data, data)
}
function chooseFile(event: Event) {
  const target = event.target
  if (target instanceof HTMLInputElement) file.value = target.files?.item(0) ?? null
}
function prepareAttachment() {
  const data = view.value
  if (!data?.capabilities.attachments || !file.value) return
  if (file.value.size < 1 || file.value.size > 10485760) {
    validation.value = 'El archivo debe tener entre 1 byte y 10 MB.'
    return
  }
  validation.value = ''
  command.prepare({ file: file.value, expectedVersion: data.version, visibility: 'public' }, data, true)
}
</script>
<template>
  <section aria-label="Conversación privada de soporte" class="space-y-4">
    <p v-if="message && command.authorize()" data-testid="customer-support-message" role="status">{{ message }}</p>
    <p v-if="validation && command.authorize()" role="alert">{{ validation }}</p>
    <div v-if="view" data-testid="customer-support-facts" class="space-y-4">
      <SupportTicketFacts :snapshot="view" />
      <form v-if="view.capabilities.reply && !intent" class="space-y-3" @submit.prevent="prepare">
        <label class="block"
          >Tu respuesta
          <textarea
            v-model="body"
            data-testid="customer-support-body"
            required
            maxlength="5000"
            rows="5"
            class="w-full rounded border p-2"
          />
        </label>
        <p>No incluyas contraseñas, datos de tarjeta ni documentos ajenos al caso.</p>
        <button data-testid="customer-support-prepare" :disabled="busy" class="rounded border p-2">
          Revisar respuesta
        </button>
      </form>
      <p v-else-if="!view.capabilities.reply && !intent">
        El estado confirmado no admite nuevas respuestas. Una resolución de la consulta no confirma un reembolso ni una
        actuación fiscal.
      </p>
      <div v-if="view.capabilities.attachments && !intent" class="space-y-2">
        <label class="block"
          >Adjuntar evidencia privada JPEG, PNG o PDF (máximo 10 MB)
          <input type="file" accept="image/png,image/jpeg,application/pdf" @change="chooseFile"
        /></label>
        <button :disabled="busy || !file" class="rounded border p-2" @click="prepareAttachment()">
          Preparar adjunto en cuarentena
        </button>
      </div>
    </div>
    <div v-if="intent && command.authorize()" class="rounded border p-3">
      <p>Respuesta o adjunto preparado con contenido y clave estables.</p>
      <button
        v-if="!ambiguous"
        data-testid="customer-support-send"
        :disabled="busy"
        class="rounded border p-2"
        @click="command.dispatch()"
      >
        Confirmar registro
      </button>
      <button
        v-else
        data-testid="customer-support-recover"
        :disabled="busy"
        class="rounded border p-2"
        @click="command.dispatch(true)"
      >
        Recuperar mismo intento
      </button>
      <button v-if="!ambiguous" :disabled="busy" class="rounded border p-2" @click="command.cancel()">
        Cancelar intento no enviado
      </button>
    </div>
  </section>
</template>
