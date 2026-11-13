<script setup lang="ts">
import {
  catalogPriceListSchema,
  catalogPriceScheduleInputSchema,
  catalogPriceCancelInputSchema,
  catalogPriceReceiptSchema,
  type CatalogPriceItem
} from '~~/shared/catalog-price-commands'
import { randomId } from '~/utils/uuid'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
type Identity = { variantId: string; variantLegacyId: number; productUuid: string }
type Intent = {
  action: 'price_schedule' | 'price_cancel'
  payload: string
  key: string
  actor: string
  identity: Identity
  priceId: string | null
}
const props = defineProps<{
  variantLegacyId: number
  runtime: unknown
  authorize: (identity: Identity, action?: Intent['action']) => boolean
  refreshList: () => Promise<unknown>
}>()
const { loggedIn, user } = useUserSession()
const selectedId = props.variantLegacyId
const {
  data,
  status,
  error: readError,
  refresh
} = await useFetch<unknown>('/api/admin/prices', {
  key: `admin-governed-price:${props.variantLegacyId}`,
  query: { variant: props.variantLegacyId, page: 1, perPage: 1, historyPerPage: 1 },
  immediate: props.runtime === 'cloudflare',
  server: props.runtime === 'cloudflare'
})
let active = true,
  generation = 0
function actor() {
  if (loggedIn.value !== true || !user.value) return null
  const descriptor = Object.getOwnPropertyDescriptor(user.value, 'id')
  return descriptor &&
    Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'string' &&
    descriptor.value.length > 0
    ? descriptor.value
    : null
}
const loading = ref(false),
  saving = ref(false),
  blocked = ref(false),
  failedRead = ref(false),
  uncertain = ref(false)
const message = ref(''),
  notice = ref(''),
  confirmed = ref(false),
  cancelConfirmed = ref(false),
  cancelReason = ref('')
const form = reactive({
  gross: '',
  compareAt: '',
  validFrom: '',
  reason: '',
  tiers: [] as Array<{ minimumQuantity: string; unitGross: string }>
})
const intent = shallowRef<Intent | null>(null)
const baseline = shallowRef<{ version: number; head: string | null } | null>(null)
function currentItem(): CatalogPriceItem | null {
  if (
    !active ||
    props.runtime !== 'cloudflare' ||
    !actor() ||
    status.value !== 'success' ||
    readError.value != null ||
    failedRead.value ||
    loading.value
  )
    return null
  const parsed = catalogPriceListSchema.safeParse(data.value)
  if (!parsed.success || parsed.data.items.length !== 1) return null
  const item = parsed.data.items[0]!
  return item.id === props.variantLegacyId &&
    props.authorize({ variantId: item.variantId, variantLegacyId: item.id, productUuid: item.productUuid })
    ? item
    : null
}
const current = computed(currentItem)
function capabilities() {
  const parsed = catalogPriceListSchema.safeParse(data.value)
  return parsed.success ? parsed.data.capabilities : null
}
function permitted(action: Intent['action']) {
  const item = currentItem()
  return (
    item?.currency === 'EUR' &&
    capabilities()?.priceWrite === false &&
    (action === 'price_schedule' ? capabilities()?.priceSchedule === true : capabilities()?.priceCancel === true) &&
    props.authorize({ variantId: item.variantId, variantLegacyId: item.id, productUuid: item.productUuid }, action)
  )
}
const canPrepare = computed(() => {
  const item = current.value
  return (
    !!item &&
    !!baseline.value &&
    item.catalogVersion === baseline.value.version &&
    (item.latestApproved?.id ?? null) === baseline.value.head &&
    !intent.value &&
    !blocked.value &&
    !saving.value &&
    !loading.value
  )
})
const canSchedule = computed(() => canPrepare.value && permitted('price_schedule'))
const canCancel = computed(() => canPrepare.value && permitted('price_cancel') && current.value?.cancellable === true)
function matches(value: Intent) {
  const item = currentItem()
  return (
    !!item &&
    actor() === value.actor &&
    item.variantId === value.identity.variantId &&
    item.id === value.identity.variantLegacyId &&
    item.productUuid === value.identity.productUuid &&
    permitted(value.action)
  )
}
const canReplay = computed(
  () => !!intent.value && uncertain.value && !saving.value && !loading.value && matches(intent.value)
)
watch(
  current,
  (item) => {
    if (item && !baseline.value && !intent.value)
      baseline.value = { version: item.catalogVersion, head: item.latestApproved?.id ?? null }
  },
  { immediate: true }
)
watch(
  () => [props.variantLegacyId, props.runtime, actor()],
  () => {
    generation++
    intent.value = null
    uncertain.value = false
    blocked.value = true
    baseline.value = null
    saving.value = false
    loading.value = false
    failedRead.value = true
  }
)
watch(
  () => [form.gross, form.compareAt, form.validFrom, form.reason, form.tiers],
  () => {
    confirmed.value = false
  },
  { deep: true }
)
watch(cancelReason, () => {
  cancelConfirmed.value = false
})
onBeforeUnmount(() => {
  active = false
  generation++
})
const deterministic: Record<string, string> = {
  version_conflict: 'Las cantidades o el producto han cambiado. Consulta antes de preparar otro comando.',
  head_conflict: 'La última aprobación ha cambiado. Consulta la cabeza actual; no se ha sobrescrito.',
  idempotency_conflict: 'Esta clave ya identifica otro comando. Consulta antes de preparar otro.',
  quantity_conflict: 'Los tramos no cumplen las cantidades actuales de la referencia.',
  invalid_window: 'La fecha ya no está permitida o no es posterior a la última aprobación.',
  not_cancellable: 'Sólo puede cancelarse la última aprobación que aún no ha entrado en vigor.',
  variant_not_editable: 'Esta referencia ya no admite cambios de precio.',
  not_found: 'La referencia o el precio ya no están disponibles.',
  invalid_input: 'Revisa el precio, la fecha, los tramos y el motivo.',
  conflict: 'El servidor ha rechazado el cambio. Consulta antes de preparar otro.',
  csrf_rejected: 'Abre el panel desde su dirección autorizada.',
  rate_limited: 'Hay demasiados intentos. Espera antes de consultar o continuar.',
  body_too_large: 'El comando supera el tamaño permitido. Reduce los datos antes de continuar.'
}
// Live authorization is checked again after the atomic commit. An authorization
// error therefore cannot establish that the command was not recorded.
const authorizationFailures = new Set(['forbidden', 'mfa_required', 'email_unverified', 'unauthenticated'])
function ownData(value: unknown, field: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
function errorCode(envelope: unknown): string | null {
  try {
    const code = ownData(ownData(catalogPolicyOwnJson(envelope), 'error'), 'code')
    return typeof code === 'string' && code.length <= 100 ? code : null
  } catch {
    return null
  }
}
async function reload() {
  if (
    !active ||
    props.runtime !== 'cloudflare' ||
    props.variantLegacyId !== selectedId ||
    !actor() ||
    saving.value ||
    loading.value
  )
    return
  loading.value = true
  failedRead.value = false
  const request = ++generation,
    owner = actor()
  try {
    await refresh()
    if (!active || request !== generation || actor() !== owner) return
  } catch {
    if (active && request === generation && actor() === owner) failedRead.value = true
  } finally {
    if (active && request === generation) loading.value = false
  }
  if (!active || request !== generation || actor() !== owner) return
  const item = currentItem()
  if (!item) {
    message.value = 'No se ha podido confirmar la tarifa actual. Reintenta sólo la consulta.'
    return
  }
  if (!intent.value) {
    baseline.value = { version: item.catalogVersion, head: item.latestApproved?.id ?? null }
    blocked.value = false
    confirmed.value = false
    cancelConfirmed.value = false
  }
}
async function dispatch(value: Intent) {
  if (!active || saving.value || loading.value || !matches(value) || typeof window === 'undefined') return
  saving.value = true
  uncertain.value = true
  message.value = ''
  notice.value = ''
  const request = ++generation
  let responseCode: string | null = null
  try {
    const result: unknown = await $fetch(
      value.action === 'price_schedule'
        ? '/api/admin/prices'
        : `/api/admin/prices/${encodeURIComponent(value.priceId!)}/cancel`,
      {
        method: 'POST',
        body: JSON.parse(value.payload),
        headers: { Origin: window.location.origin, 'Idempotency-Key': value.key },
        // ofetch's FetchError.data is an accessor. Capture its actual parsed
        // JSON at the response hook without evaluating error/provider getters.
        onResponseError(context: unknown) {
          responseCode = errorCode(ownData(ownData(context, 'response'), '_data'))
        },
        retry: 0
      }
    )
    if (!active || request !== generation || !matches(value)) return
    const receipt = catalogPriceReceiptSchema.safeParse(result)
    if (
      !receipt.success ||
      receipt.data.action !== value.action ||
      receipt.data.variantId !== value.identity.variantId ||
      receipt.data.variantLegacyId !== value.identity.variantLegacyId ||
      (value.priceId !== null && receipt.data.priceId !== value.priceId)
    )
      throw new Error('unconfirmed_price_receipt')
    intent.value = null
    uncertain.value = false
    blocked.value = true
    notice.value = 'Comando registrado. Consulta la tarifa vigente; el recibo no sustituye esa lectura.'
    saving.value = false
    await reload()
    if (active && actor() === value.actor && currentItem()) await props.refreshList()
  } catch (failure) {
    if (!active || request !== generation || !matches(value)) return
    const code = responseCode ?? errorCode(ownData(failure, 'data'))
    const statusCode = ownData(failure, 'statusCode') ?? ownData(failure, 'status')
    if (
      (typeof code === 'string' && authorizationFailures.has(code)) ||
      ((statusCode === 401 || statusCode === 403) && !(typeof code === 'string' && Object.hasOwn(deterministic, code)))
    ) {
      uncertain.value = true
      blocked.value = true
      failedRead.value = true
      message.value =
        'La sesión o el permiso ya no permiten confirmar el resultado. No sabemos si el comando quedó registrado. Recupera una consulta autorizada antes de reintentar exactamente este comando.'
    } else if (typeof code === 'string' && Object.hasOwn(deterministic, code)) {
      intent.value = null
      uncertain.value = false
      blocked.value = true
      failedRead.value = true
      message.value = deterministic[code]!
    } else {
      uncertain.value = true
      blocked.value = true
      message.value =
        'No sabemos si el comando quedó registrado. Consulta el estado actual o reintenta exactamente el mismo comando; no se enviará automáticamente.'
    }
  } finally {
    if (active && request === generation) saving.value = false
  }
}
function cents(value: string): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:[.,]\d{1,2})?$/.test(value)) return null
  const [whole, fraction = ''] = value.replace(',', '.').split('.')
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null
}
async function schedule() {
  if (!canSchedule.value || confirmed.value !== true) return
  const item = currentItem(),
    owner = actor()
  if (!item || !owner || !baseline.value) return
  let validFrom = ''
  if (typeof form.validFrom === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(form.validFrom)) {
    const date = new Date(form.validFrom)
    if (Number.isFinite(date.getTime())) validFrom = date.toISOString()
  }
  const input = catalogPriceScheduleInputSchema.safeParse({
    variantId: item.variantId,
    expectedCatalogVersion: baseline.value.version,
    expectedLatestApprovedId: baseline.value.head,
    grossCents: cents(form.gross),
    compareAtGrossCents: form.compareAt === '' ? null : cents(form.compareAt),
    volumeTiers: form.tiers.map((tier) => ({
      minimumQuantity: /^[1-9]\d*$/.test(tier.minimumQuantity) ? Number(tier.minimumQuantity) : null,
      unitGrossCents: cents(tier.unitGross)
    })),
    validFrom,
    reason: form.reason
  })
  if (!input.success) {
    message.value = 'Revisa el precio, la fecha, los tramos y un motivo de 3 a 500 caracteres.'
    return
  }
  const value: Intent = {
    action: 'price_schedule',
    payload: JSON.stringify(input.data),
    key: randomId(),
    actor: owner,
    identity: { variantId: item.variantId, variantLegacyId: item.id, productUuid: item.productUuid },
    priceId: null
  }
  intent.value = value
  await dispatch(value)
}
async function cancel() {
  if (!canCancel.value || cancelConfirmed.value !== true) return
  const item = currentItem(),
    owner = actor()
  if (!item?.latestApproved || !owner || !baseline.value) return
  const input = catalogPriceCancelInputSchema.safeParse({
    expectedCatalogVersion: baseline.value.version,
    expectedLatestApprovedId: baseline.value.head,
    reason: cancelReason.value
  })
  if (!input.success) {
    message.value = 'Indica un motivo de cancelación de 3 a 500 caracteres.'
    return
  }
  const value: Intent = {
    action: 'price_cancel',
    payload: JSON.stringify(input.data),
    key: randomId(),
    actor: owner,
    identity: { variantId: item.variantId, variantLegacyId: item.id, productUuid: item.productUuid },
    priceId: item.latestApproved.id
  }
  intent.value = value
  await dispatch(value)
}
async function replay() {
  const value = intent.value
  if (value && canReplay.value) await dispatch(value)
}
async function discard() {
  if (saving.value || loading.value || !currentItem()) return
  intent.value = null
  uncertain.value = false
  blocked.value = true
  await reload()
}
</script>

<template>
  <div class="adm-stack" :aria-busy="saving || loading || status === 'pending'">
    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-check" :title="notice" />
    <UAlert
      v-if="message"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="message"
    />
    <p v-if="loading || status === 'idle' || status === 'pending'" role="status" class="adm-help">
      Consultando el precio actual…
    </p>
    <UAlert
      v-else-if="!current"
      role="alert"
      color="warning"
      variant="subtle"
      title="No hemos podido confirmar el precio actual de esta referencia"
      description="Pulsa «Actualizar datos» para volver a consultarlo."
    />

    <div class="flex flex-wrap items-start justify-between gap-3">
      <div v-if="current" class="min-w-0">
        <p class="font-semibold text-[var(--text-strong)]">
          {{ current.product }} · <span class="font-mono">{{ current.sku }}</span>
        </p>
        <p class="adm-help">
          {{
            current.latestApproved
              ? `Último cambio aprobado: ${adminDate(current.latestApproved.validFrom, true)}.`
              : 'Sin cambios de precio aprobados todavía.'
          }}
          Pedido mínimo {{ current.quantityRules.minimumQuantity }}, en múltiplos de
          {{ current.quantityRules.quantityIncrement }}.
        </p>
      </div>
      <UButton
        type="button"
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-rotate-cw"
        class="ml-auto"
        :disabled="saving || loading || runtime !== 'cloudflare' || !actor()"
        @click="reload"
        >Actualizar datos</UButton
      >
    </div>

    <template v-if="current">
      <p v-if="!capabilities()?.priceSchedule && !capabilities()?.priceCancel" role="status" class="adm-help">
        Solo consulta: tu usuario no tiene permiso para cambiar precios.
      </p>
      <form aria-labelledby="governed-price-title" class="adm-card" @submit.prevent="schedule">
        <fieldset :disabled="!canSchedule" class="adm-card__body space-y-4">
          <legend id="governed-price-title" class="adm-card__title">Programar un precio</legend>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Precio con IVA (€)" required
              ><UInput v-model="form.gross" inputmode="decimal" required class="w-full"
            /></UFormField>
            <UFormField label="Precio anterior (€)" hint="Opcional. Se muestra tachado junto al nuevo."
              ><UInput v-model="form.compareAt" inputmode="decimal" class="w-full"
            /></UFormField>
            <UFormField label="En vigor desde (hora local)" required
              ><UInput v-model="form.validFrom" type="datetime-local" step="1" required class="w-full"
            /></UFormField>
            <UFormField label="Motivo del cambio" required
              ><UInput v-model="form.reason" required maxlength="500" class="w-full"
            /></UFormField>
          </div>
          <div class="space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="adm-label">Precios por cantidad</p>
              <UButton
                type="button"
                color="neutral"
                variant="outline"
                size="sm"
                icon="i-lucide-plus"
                :disabled="form.tiers.length >= 20"
                @click="form.tiers.push({ minimumQuantity: '', unitGross: '' })"
                >Añadir tramo</UButton
              >
            </div>
            <p v-if="!form.tiers.length" class="adm-help">Sin tramos: el mismo precio para cualquier cantidad.</p>
            <div v-for="(tier, index) in form.tiers" :key="index" class="flex flex-wrap items-end gap-2">
              <UFormField :label="`Desde unidades · tramo ${index + 1}`" class="min-w-0 flex-1"
                ><UInput v-model="tier.minimumQuantity" inputmode="numeric" required class="w-full"
              /></UFormField>
              <UFormField :label="`Precio unitario (€) · tramo ${index + 1}`" class="min-w-0 flex-1"
                ><UInput v-model="tier.unitGross" inputmode="decimal" required class="w-full"
              /></UFormField>
              <UButton
                type="button"
                color="error"
                variant="ghost"
                :aria-label="`Quitar tramo ${index + 1}`"
                @click="form.tiers.splice(index, 1)"
                >Quitar</UButton
              >
            </div>
          </div>
          <label class="adm-check"
            ><input v-model="confirmed" type="checkbox" />He revisado el importe, la fecha y los tramos.</label
          >
          <div class="flex justify-end">
            <UButton type="submit" :disabled="!canSchedule || !confirmed" :loading="saving"
              >Registrar programación</UButton
            >
          </div>
        </fieldset>
      </form>
      <form
        v-if="current.latestApproved"
        aria-labelledby="governed-cancel-title"
        class="adm-card"
        @submit.prevent="cancel"
      >
        <fieldset :disabled="!canCancel" class="adm-card__body space-y-3">
          <legend id="governed-cancel-title" class="adm-card__title">
            Cancelar última programación · {{ current.sku }}
          </legend>
          <p class="adm-help">
            Solo se puede cancelar el último cambio aprobado que aún no ha entrado en vigor. Vuelve a aplicarse el
            precio anterior y la cancelación queda anotada en el historial.
          </p>
          <UFormField label="Motivo de la cancelación" required
            ><UInput v-model="cancelReason" required maxlength="500" class="w-full"
          /></UFormField>
          <label class="adm-check"
            ><input v-model="cancelConfirmed" type="checkbox" />Confirmo que este precio futuro no debe
            aplicarse.</label
          >
          <div class="flex justify-end">
            <UButton type="submit" color="error" :disabled="!canCancel || !cancelConfirmed" :loading="saving"
              >Cancelar programación</UButton
            >
          </div>
        </fieldset>
      </form>
    </template>
    <div v-if="intent && uncertain" class="flex flex-wrap gap-2">
      <UButton type="button" :disabled="!canReplay" :loading="saving" @click="replay"
        >Reintentar exactamente este comando</UButton
      >
      <UButton
        type="button"
        color="neutral"
        variant="outline"
        :disabled="saving || loading || !current"
        @click="discard"
        >Descartar intento y consultar antes de otro</UButton
      >
    </div>
    <p class="adm-help">
      Estos cambios solo afectan al precio. No aprueban la publicación ni alteran existencias, IVA o pedidos ya hechos.
      El precio mínimo de 30 días se calcula con los precios aprobados que constan: si faltan periodos, no acreditan un
      historial completo ni la validez legal de un descuento.
    </p>
  </div>
</template>
