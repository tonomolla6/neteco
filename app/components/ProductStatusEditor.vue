<script setup lang="ts">
import { randomId } from '~/utils/uuid'

type Status = 'draft' | 'review' | 'published' | 'hidden' | 'discontinued'
type Identity = { id: number; uuid: string; version: number; status: Status }
type Command = Readonly<{ identity: Identity; payload: string; key: string; status: Status }>
const props = defineProps<{
  product: unknown
  productId: string
  runtime: unknown
  readStatus: string
  authorize: (identity: { id: number; uuid: string; version?: number; status?: Status }) => boolean
  refreshProduct: () => Promise<unknown>
  readinessAvailable: boolean
  refreshReadiness: () => Promise<unknown>
}>()
const LABELS: Record<Status, string> = {
  draft: 'Borrador',
  review: 'En revisión',
  published: 'Publicado',
  hidden: 'Oculto',
  discontinued: 'Descatalogado'
}
const TRANSITIONS: Record<Status, readonly Status[]> = {
  draft: ['review', 'hidden', 'discontinued'],
  review: ['draft', 'published', 'hidden'],
  published: ['hidden', 'discontinued'],
  hidden: ['draft', 'review', 'published', 'discontinued'],
  discontinued: ['draft']
}
function ownData(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field)
      return field in value && !!descriptor && Object.hasOwn(descriptor, 'value')
    })
  )
}
function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && Object.hasOwn(LABELS, value)
}
function currentIdentity(): Identity | null {
  const value = props.product
  if (
    props.runtime !== 'cloudflare' ||
    props.readStatus !== 'success' ||
    !/^[1-9]\d{0,15}$/.test(props.productId) ||
    !Number.isSafeInteger(Number(props.productId)) ||
    !ownData(value, ['id', 'uuid', 'catalogVersion', 'source', 'status', 'capabilities']) ||
    value.source !== 'cloudflare' ||
    value.id !== Number(props.productId) ||
    typeof value.uuid !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.uuid) ||
    typeof value.catalogVersion !== 'number' ||
    !Number.isSafeInteger(value.catalogVersion) ||
    value.catalogVersion < 1 ||
    !isStatus(value.status) ||
    !ownData(value.capabilities, ['productDetailRead', 'productStatusTransition']) ||
    value.capabilities.productDetailRead !== true ||
    value.capabilities.productStatusTransition !== true
  )
    return null
  return { id: Number(props.productId), uuid: value.uuid, version: value.catalogVersion, status: value.status }
}
const current = computed(() => {
  const value = currentIdentity()
  return value && props.authorize(value) ? value : null
})
const baseline = ref<Identity | null>(null)
const target = ref('')
const reason = ref('')
const confirmed = ref(false)
const saving = ref(false)
const reloading = ref(false)
const checkingReadiness = ref(false)
const pending = ref(false)
const uncertain = ref(false)
const blocked = ref(false)
const error = ref('')
const notice = ref('')
const publicationBlocked = ref(false)
let command: Command | null = null
let active = true
let generation = 0
const stale = computed(
  () =>
    !!baseline.value &&
    !!current.value &&
    (baseline.value.id !== current.value.id ||
      baseline.value.uuid !== current.value.uuid ||
      baseline.value.version !== current.value.version ||
      baseline.value.status !== current.value.status)
)
const canPrepare = computed(
  () =>
    !!current.value &&
    !!baseline.value &&
    !stale.value &&
    !blocked.value &&
    !pending.value &&
    !saving.value &&
    !reloading.value &&
    !checkingReadiness.value &&
    baseline.value.version < Number.MAX_SAFE_INTEGER &&
    props.authorize(baseline.value)
)
const choices = computed(() => (baseline.value ? TRANSITIONS[baseline.value.status] : []))
function validReason(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    [...value].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127) &&
    value.trim().length >= 3 &&
    value.trim().length <= 500
  )
}
const canSubmit = computed(
  () =>
    canPrepare.value &&
    isStatus(target.value) &&
    choices.value.includes(target.value) &&
    validReason(reason.value) &&
    confirmed.value === true
)
const impact = computed(() =>
  target.value === 'published'
    ? 'Publicar hará visible el producto únicamente si el servidor valida todos los requisitos.'
    : target.value === 'hidden'
      ? 'Ocultar retirará el producto de la venta pública.'
      : target.value === 'discontinued'
        ? 'Descatalogar retirará el producto del catálogo comercial.'
        : 'Este cambio modifica el estado editorial; no publica el producto.'
)

function reset(value: Identity) {
  baseline.value = { ...value }
  target.value = ''
  reason.value = ''
  confirmed.value = false
  command = null
  pending.value = false
  uncertain.value = false
  blocked.value = false
  publicationBlocked.value = false
}
watch(
  () => [props.product, props.readStatus, props.runtime],
  () => {
    const value = currentIdentity()
    if (
      value &&
      props.authorize(value) &&
      !command &&
      !saving.value &&
      !blocked.value &&
      !target.value &&
      !reason.value
    )
      reset(value)
  },
  { immediate: true, deep: true }
)
watch(target, () => {
  confirmed.value = false
})

const ERROR_MESSAGES: Record<string, string> = {
  version_conflict: 'El producto ha cambiado. Consulta de nuevo antes de preparar otro cambio; no se ha sobrescrito.',
  idempotency_conflict:
    'El comando no coincide con la clave registrada. Consulta de nuevo; no lo repitas con otra clave.',
  invalid_transition: 'Esta transición ya no está permitida. Consulta el estado actual antes de otro cambio.',
  publication_blocked:
    'No se ha publicado el producto: la validación del servidor ha bloqueado la publicación. Revisa las incidencias y limitaciones de la consulta informativa.',
  conflict: 'El servidor ha rechazado este cambio. Consulta de nuevo antes de preparar otro.',
  forbidden: 'Ya no tienes permiso para cambiar este estado. Revisa tu acceso y consulta de nuevo.',
  mfa_required: 'Necesitas verificar el segundo factor y consultar de nuevo.',
  unauthenticated: 'Tu sesión no permite este cambio. Inicia sesión y consulta de nuevo.',
  email_unverified: 'Verifica tu correo y consulta de nuevo antes de cambiar el estado.',
  not_found: 'El producto no está disponible. Consulta de nuevo.',
  invalid_input: 'El servidor ha rechazado los datos. Consulta de nuevo y revisa el estado y el motivo.',
  body_too_large: 'El motivo supera el tamaño permitido. Consulta de nuevo y reduce el texto.',
  rate_limited: 'Hay demasiados intentos. Espera y consulta de nuevo antes de otro cambio.',
  csrf_rejected: 'El origen de la petición no está autorizado. Recarga el panel desde su dirección correcta.'
}
function sameOrigin(value: Command) {
  const identity = currentIdentity()
  return (
    active &&
    !!identity &&
    identity.id === value.identity.id &&
    identity.uuid === value.identity.uuid &&
    props.authorize({ id: value.identity.id, uuid: value.identity.uuid })
  )
}
async function dispatch(value: Command, replay: boolean) {
  if (
    !active ||
    saving.value ||
    reloading.value ||
    checkingReadiness.value ||
    !sameOrigin(value) ||
    typeof window === 'undefined'
  )
    return
  if (!replay && !props.authorize(value.identity)) return
  saving.value = true
  error.value = ''
  notice.value = ''
  const request = ++generation
  try {
    const result: unknown = await $fetch(`/api/admin/products/${value.identity.id}/status`, {
      method: 'PUT',
      body: JSON.parse(value.payload),
      headers: { Origin: window.location.origin, 'Idempotency-Key': value.key }
    })
    if (request !== generation || !sameOrigin(value)) return
    if (
      !ownData(result, ['source', 'productId', 'productUuid', 'catalogVersion', 'status', 'active', 'updated']) ||
      result.source !== 'cloudflare' ||
      result.productId !== value.identity.id ||
      result.productUuid !== value.identity.uuid ||
      result.catalogVersion !== value.identity.version + 1 ||
      result.status !== value.status ||
      result.active !== (value.status === 'published') ||
      result.updated !== true
    )
      throw new Error('unconfirmed_receipt')
    command = null
    pending.value = false
    uncertain.value = false
    blocked.value = true
    notice.value = 'Cambio de estado registrado. La consulta actualizada muestra el estado vigente.'
    await props.refreshProduct()
    await nextTick()
    if (request !== generation || !sameOrigin(value)) return
    const fresh = currentIdentity()
    if (fresh && fresh.version >= value.identity.version + 1) reset(fresh)
    else
      error.value =
        'El cambio está registrado, pero falta una consulta actualizada. Consulta de nuevo antes de otro cambio.'
  } catch (cause) {
    if (request !== generation || !sameOrigin(value)) return
    if (!command) {
      error.value =
        'El cambio está registrado, pero no se ha podido actualizar la consulta. Consulta de nuevo antes de otro cambio.'
      return
    }
    const candidate = cause as { data?: { error?: { code?: unknown } } } | null
    const code = candidate?.data?.error?.code
    if (typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)) {
      command = null
      pending.value = false
      uncertain.value = false
      blocked.value = true
      publicationBlocked.value = code === 'publication_blocked'
      error.value = ERROR_MESSAGES[code]!
    } else {
      uncertain.value = true
      error.value =
        'No podemos confirmar si el cambio se registró. Reintenta el mismo comando con su misma clave o consulta de nuevo; no prepares otro cambio.'
    }
  } finally {
    if (request === generation) saving.value = false
  }
}
async function saveStatus() {
  if (!active || command || !canPrepare.value || !baseline.value || !props.authorize(baseline.value)) return
  if (!isStatus(target.value) || !choices.value.includes(target.value)) {
    error.value = 'Selecciona una transición permitida.'
    return
  }
  if (!validReason(reason.value)) {
    error.value = 'Explica el motivo con entre 3 y 500 caracteres, sin caracteres de control.'
    return
  }
  if (confirmed.value !== true) {
    error.value = 'Confirma el impacto del cambio antes de enviarlo.'
    return
  }
  command = Object.freeze({
    identity: Object.freeze({ ...baseline.value }),
    status: target.value,
    payload: JSON.stringify({
      status: target.value,
      expectedVersion: baseline.value.version,
      reason: reason.value.trim()
    }),
    key: randomId()
  })
  pending.value = true
  await dispatch(command, false)
}
async function retry() {
  if (active && !blocked.value && uncertain.value && command) await dispatch(command, true)
}
async function reload() {
  const value = currentIdentity()
  if (
    !active ||
    saving.value ||
    reloading.value ||
    checkingReadiness.value ||
    !value ||
    !props.authorize({ id: value.id, uuid: value.uuid })
  )
    return
  reloading.value = true
  try {
    await props.refreshProduct()
    await nextTick()
    const fresh = currentIdentity()
    if (active && fresh && fresh.id === value.id && fresh.uuid === value.uuid && props.authorize(fresh)) {
      if (command) {
        error.value =
          'Consulta actualizada. El intento pendiente conserva su misma clave y sus datos; no se ha reenviado.'
        notice.value = ''
      } else {
        reset(fresh)
        error.value = ''
        notice.value = ''
      }
    } else error.value = 'No se ha confirmado una consulta autorizada actual. Ningún cambio se ha reenviado.'
  } catch {
    error.value = 'No se ha podido actualizar la consulta. Ningún cambio se ha reenviado.'
  } finally {
    reloading.value = false
  }
}
async function consultReadiness() {
  const value = currentIdentity()
  if (
    !active ||
    saving.value ||
    reloading.value ||
    checkingReadiness.value ||
    !value ||
    !props.readinessAvailable ||
    !props.authorize(value)
  )
    return
  checkingReadiness.value = true
  try {
    await props.refreshReadiness()
  } catch {
    error.value = 'No se ha podido actualizar la consulta informativa. Esto no habilita publicación.'
  } finally {
    checkingReadiness.value = false
  }
}
onBeforeUnmount(() => {
  active = false
  ++generation
})
</script>

<template>
  <AdminCard
    aria-labelledby="product-status-heading"
    data-product-status-editor
    description="Cada cambio pide un motivo y una confirmación. La consulta informativa no autoriza la publicación: la tienda comprueba los requisitos antes de publicar."
  >
    <template #title><span id="product-status-heading">Cambiar estado editorial</span></template>
    <template v-if="baseline" #actions>
      <AdminBadge :status="baseline.status">{{ LABELS[baseline.status] }}</AdminBadge>
    </template>
    <div class="adm-stack">
      <UAlert
        v-if="!current"
        role="status"
        color="neutral"
        variant="subtle"
        title="Ahora mismo no puedes cambiar el estado de este producto: hace falta cargar la ficha de nuevo y tener permiso para ello."
      />
      <UAlert
        v-if="stale"
        role="alert"
        color="warning"
        variant="subtle"
        title="La ficha ha cambiado desde que la abriste. Actualízala antes de preparar otro cambio."
      />
      <UAlert v-if="error" id="product-status-error" role="alert" color="error" variant="subtle" :title="error" />
      <UAlert v-if="notice" role="status" color="success" variant="subtle" :title="notice" />
      <form
        v-if="current"
        class="adm-stack"
        :aria-busy="saving || reloading || checkingReadiness"
        @submit.prevent="saveStatus"
      >
        <fieldset :disabled="!canPrepare" class="adm-stack">
          <p v-if="baseline" class="adm-help">
            Estado consultado: {{ LABELS[baseline.status] }} · versión {{ baseline.version }}.
          </p>
          <div class="adm-form-grid">
            <div class="adm-field">
              <label for="product-target-status" class="adm-label">Nuevo estado</label>
              <select id="product-target-status" v-model="target" required class="adm-input">
                <option value="" disabled>Selecciona un estado</option>
                <option v-for="choice in choices" :key="choice" :value="choice">{{ LABELS[choice] }}</option>
              </select>
            </div>
            <div class="adm-field">
              <label for="product-status-reason" class="adm-label">Motivo del cambio de estado</label>
              <input
                id="product-status-reason"
                v-model="reason"
                type="text"
                required
                minlength="3"
                maxlength="500"
                class="adm-input"
                aria-describedby="product-status-impact"
              />
            </div>
          </div>
          <p id="product-status-impact" class="adm-help">{{ impact }}</p>
          <label class="adm-check"
            ><input v-model="confirmed" type="checkbox" required /><span
              >Confirmo que entiendo el efecto de este cambio de estado.</span
            ></label
          >
          <div>
            <button type="submit" class="adm-btn adm-btn--secondary" :disabled="!canSubmit || saving">
              <UIcon v-if="saving" name="i-lucide-loader-circle" class="size-4 animate-spin" />Cambiar estado
            </button>
          </div>
        </fieldset>
        <p v-if="saving" role="status" class="adm-help">Registrando el cambio de estado…</p>
      </form>
    </div>
    <template #footer>
      <div class="flex flex-wrap gap-2">
        <button
          v-if="uncertain"
          type="button"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          :disabled="!current || saving || reloading || checkingReadiness"
          @click="retry"
        >
          Reintentar el mismo cambio
        </button>
        <button
          type="button"
          class="adm-btn adm-btn--ghost adm-btn--sm"
          :disabled="!current || saving || reloading || checkingReadiness"
          @click="reload"
        >
          <UIcon
            :name="reloading ? 'i-lucide-loader-circle' : 'i-lucide-rotate-cw'"
            class="size-4"
            :class="reloading && 'animate-spin'"
          />
          Actualizar estado
        </button>
        <button
          v-if="publicationBlocked && readinessAvailable"
          type="button"
          class="adm-btn adm-btn--ghost adm-btn--sm"
          :disabled="!current || saving || reloading || checkingReadiness"
          @click="consultReadiness"
        >
          <UIcon v-if="checkingReadiness" name="i-lucide-loader-circle" class="size-4 animate-spin" />
          Volver a revisar qué falta para publicar
        </button>
      </div>
    </template>
  </AdminCard>
</template>
