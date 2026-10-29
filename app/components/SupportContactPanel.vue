<script setup lang="ts">
import {
  supportOptionsSchema,
  supportContactInputSchema,
  supportUuid,
  type SupportOptions,
  type SupportReceipt
} from '~~/shared/support-operations'
import { useSupportCommand } from './support/commands'
import { supportCategoryLabels } from './support/labels'
const props = defineProps<{
  snapshot: unknown
  actorId: string
  runtime: unknown
  authorize: () => boolean
  reload: () => Promise<unknown>
  orderId?: string
  orderReference?: string
  productSlug?: string
  categorySlug?: string
}>()
const emit = defineEmits<{ confirmed: [receipt: SupportReceipt]; pending: [value: boolean] }>()
const form = reactive({
  name: '',
  email: '',
  phone: '',
  category: 'other',
  subject: '',
  message: '',
  orderReference: props.orderReference ?? '',
  privacyAcknowledged: false,
  website: ''
})
const validation = ref(''),
  challengeToken = ref('')
let challengeExpiresAt = 0,
  preparedWithChallenge = false,
  dispatchCredential: { token: string; expiresAt: number; siteKey: string | null; revoked: boolean } | null = null
const decode = (raw: unknown): SupportOptions | null => {
  const value = supportOptionsSchema.safeParse(raw)
  return value.success ? value.data : null
}
const authorityEpoch = ref(0)
const owner = () => (props.actorId ? props.actorId + ':' + authorityEpoch.value : null)
const command = useSupportCommand({
  owner,
  runtime: () => props.runtime,
  authorize: () => props.authorize(),
  reload: () => props.reload(),
  decode,
  facts: (value) => ({ ref: null, version: null, allowed: !value.privacyReviewRequired && value.policy !== null }),
  endpoint: () => '/api/support/tickets',
  method: 'POST',
  fetch: (endpoint, options) => {
    // Credential is renewable transport, deliberately excluded from the server
    // business payload hash. Key and every frozen business field remain exact.
    const credential = dispatchCredential
    if (credential && (credential.revoked || Date.now() >= credential.expiresAt)) {
      validation.value = 'La respuesta antiabuso ha caducado. Renueva el desafío antes de recuperar el mismo intento.'
      return Promise.reject(new Error('support_challenge_expired'))
    }
    if (options.body instanceof FormData) return $fetch<unknown>(endpoint, options)
    const { challengeToken: _previousCredential, ...business } = options.body
    return $fetch<unknown>(endpoint, {
      ...options,
      body: Object.freeze({
        ...business,
        ...(credential ? { challengeToken: credential.token } : {})
      })
    })
  },
  confirmed: (receipt) => {
    challengeToken.value = ''
    challengeExpiresAt = 0
    emit('confirmed', receipt)
  },
  pending: (value) => emit('pending', value)
})
const { intent, busy, ambiguous, message, contextCurrent } = command
const view = computed(() => (command.authorize() && contextCurrent.value ? decode(props.snapshot) : null))
const challengeOptions = computed(() => (command.authorize() ? decode(props.snapshot) : null))
watch(
  intent,
  (value) => {
    if (!value) preparedWithChallenge = false
  },
  { flush: 'sync' }
)
watch(
  () => challengeOptions.value?.challenge?.siteKey,
  (siteKey) => {
    if (dispatchCredential && siteKey && siteKey !== dispatchCredential.siteKey) dispatchCredential.revoked = true
    challengeToken.value = ''
    challengeExpiresAt = 0
  },
  { flush: 'sync' }
)
watch(
  () => props.snapshot,
  () => {
    if (command.authorize() && decode(props.snapshot)) command.confirmedContext()
  }
)
watch(
  () => [props.actorId, props.authorize()] as const,
  ([actorId, authorized], [previousActorId]) => {
    if (actorId === previousActorId && authorized) return
    // A regained grant is a new private context, even for the same identity.
    // The command's existing owner guard also invalidates late responses.
    authorityEpoch.value++
    form.name = ''
    form.email = ''
    form.phone = ''
    form.subject = ''
    form.message = ''
    form.orderReference = ''
    form.category = 'other'
    form.privacyAcknowledged = false
    form.website = ''
    challengeToken.value = ''
    challengeExpiresAt = 0
    validation.value = ''
    command.message.value = ''
    if (dispatchCredential) dispatchCredential.revoked = true
  },
  { flush: 'sync' }
)
function prepare() {
  if (!view.value) return
  if (view.value.challenge && (!challengeToken.value || Date.now() >= challengeExpiresAt)) {
    validation.value = 'Completa o renueva la verificación antiabuso antes de preparar la consulta.'
    return
  }
  const input = supportContactInputSchema.safeParse({
    name: form.name.trim(),
    email: form.email.trim(),
    ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
    category: form.category,
    subject: form.subject.trim(),
    message: form.message.trim(),
    privacyAcknowledged: form.privacyAcknowledged,
    website: form.website,
    ...(form.orderReference.trim() ? { orderReference: form.orderReference.trim() } : {}),
    ...(props.orderId && supportUuid.safeParse(props.actorId).success ? { orderId: props.orderId } : {}),
    ...(props.productSlug ? { productSlug: props.productSlug } : {}),
    ...(props.categorySlug ? { categorySlug: props.categorySlug } : {}),
    ...(challengeToken.value ? { challengeToken: challengeToken.value } : {})
  })
  if (!input.success) {
    validation.value = 'Comprueba los campos, el consentimiento y el mensaje (10–5000 caracteres).'
    return
  }
  validation.value = ''
  if (command.prepare(input.data, view.value)) preparedWithChallenge = !!view.value.challenge
}
function setChallengeToken(value: string) {
  const next =
    challengeOptions.value && typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/\s/.test(value)
      ? value
      : ''
  // An SDK expiry/error/reset while the confirmed widget is mounted revokes
  // this dispatch too. Hiding the widget during a fresh GET does not itself
  // expire the bounded credential already captured for that explicit attempt.
  if (dispatchCredential && challengeOptions.value && next !== dispatchCredential.token)
    dispatchCredential.revoked = true
  challengeToken.value = next
  // Shorter than Turnstile's maximum token validity; callbacks may revoke sooner.
  challengeExpiresAt = challengeToken.value ? Date.now() + 240000 : 0
}
async function dispatch(recovery = false) {
  if (busy.value) return
  const configured = challengeOptions.value?.challenge
  if ((configured || preparedWithChallenge) && (!challengeToken.value || Date.now() >= challengeExpiresAt)) {
    validation.value = 'Completa o renueva la verificación antiabuso antes de enviar el mismo intento.'
    return
  }
  dispatchCredential = challengeToken.value
    ? {
        token: challengeToken.value,
        expiresAt: challengeExpiresAt,
        siteKey: configured?.siteKey ?? null,
        revoked: false
      }
    : null
  try {
    await command.dispatch(recovery)
  } finally {
    dispatchCredential = null
  }
}
</script>
<template>
  <section aria-label="Registrar consulta contextual" class="space-y-4">
    <p v-if="message && command.authorize()" data-testid="support-contact-message" role="status">{{ message }}</p>
    <p v-if="validation" role="alert">{{ validation }}</p>
    <form v-if="view && !intent" class="space-y-3" @submit.prevent="prepare">
      <p v-if="view.privacyReviewRequired || !view.policy" role="alert">
        Formulario deshabilitado: falta confirmar la política de privacidad y atención. No se inventan plazos de
        respuesta.
      </p>
      <p v-else>
        Política {{ view.policy.reference }} v{{ view.policy.version
        }}<span v-if="view.policy.serviceHoursDescription"> · {{ view.policy.serviceHoursDescription }}</span
        >.
      </p>
      <label class="block"
        >Nombre
        <input
          v-model="form.name"
          data-testid="support-name"
          required
          minlength="2"
          maxlength="160"
          autocomplete="name"
          class="rounded border p-2"
      /></label>
      <label class="block"
        >Correo de contacto
        <input
          v-model="form.email"
          data-testid="support-email"
          type="email"
          required
          maxlength="254"
          autocomplete="email"
          class="rounded border p-2"
      /></label>
      <label class="block"
        >Teléfono opcional
        <input v-model="form.phone" type="tel" maxlength="32" autocomplete="tel" class="rounded border p-2"
      /></label>
      <label class="block"
        >Motivo
        <select v-model="form.category" data-testid="support-category" class="rounded border p-2">
          <option v-for="category in view.categories" :key="category" :value="category">
            {{ supportCategoryLabels[category] }}
          </option>
        </select></label
      >
      <label class="block"
        >Asunto
        <input
          v-model="form.subject"
          data-testid="support-subject"
          required
          minlength="5"
          maxlength="200"
          class="rounded border p-2"
      /></label>
      <label class="block"
        >Mensaje
        <textarea
          v-model="form.message"
          data-testid="support-body"
          required
          minlength="10"
          maxlength="5000"
          rows="6"
          class="w-full rounded border p-2"
        />
      </label>
      <label class="block"
        >Referencia declarada opcional <input v-model="form.orderReference" maxlength="80" class="rounded border p-2"
      /></label>
      <p>
        Una referencia o un correo no acreditan pedidos. El portal de soporte sólo muestra consultas vinculadas a tu
        cuenta verificada.
      </p>
      <div hidden aria-hidden="true">
        <label>Web <input v-model="form.website" tabindex="-1" autocomplete="off" /></label>
      </div>
      <label v-if="view.policy" class="block"
        ><input v-model="form.privacyAcknowledged" data-testid="support-privacy" type="checkbox" required /> He leído la
        <a :href="view.policy.privacyNoticePath" class="underline">política de privacidad</a> de esta consulta.</label
      >
      <button
        data-testid="support-contact-prepare"
        :disabled="busy || view.privacyReviewRequired || !view.policy"
        class="rounded border p-2"
      >
        Revisar consulta
      </button>
    </form>
    <slot
      v-if="challengeOptions"
      name="challenge"
      :set-token="setChallengeToken"
      :configuration="challengeOptions.challenge"
    >
      <p class="text-sm">
        Si se exige un desafío antiabuso, debe completarse mediante un verificador configurado. Una casilla o este
        formulario no simulan su validación.
      </p>
    </slot>
    <div v-if="intent && command.authorize()" class="rounded border p-3">
      <p>Consulta preparada con contenido y clave estables. No adjuntes secretos ni datos de tarjeta.</p>
      <p>{{ 'subject' in intent.body ? intent.body.subject : '' }}</p>
      <button
        v-if="!ambiguous"
        data-testid="support-contact-send"
        :disabled="busy"
        class="rounded border p-2"
        @click="dispatch()"
      >
        Confirmar registro
      </button>
      <button
        v-else
        data-testid="support-contact-recover"
        :disabled="busy"
        class="rounded border p-2"
        @click="dispatch(true)"
      >
        Recuperar mismo intento
      </button>
      <button v-if="!ambiguous" :disabled="busy" class="rounded border p-2" @click="command.cancel()">
        Cancelar intento no enviado
      </button>
    </div>
  </section>
</template>
