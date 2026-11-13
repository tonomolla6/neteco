<script setup lang="ts">
import { useAdminNavigation } from '../../composables/useAdminNavigation'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Operaciones · Admin' })

/**
 * Operaciones y colas.
 *
 * Los nueve contadores de esta pantalla son los que alimentan el panel «Hoy», así que aquí
 * dejan de ser el protagonista y pasan a ser contexto: lo que importa en esta pantalla es
 * poder **actuar** sobre lo que está atascado.
 *
 * Antes, las dos acciones —conciliar una transferencia y devolver un evento a la cola—
 * pedían el motivo con `window.prompt()`. Conciliar además exigía escribir el número de
 * pedido en un campo suelto dentro de la tabla y pulsar «Conciliar» sin ver en ningún
 * momento contra qué se estaba casando el ingreso.
 */
interface Operations {
  source?: string
  summary: Record<string, number | null>
  capabilities?: Record<string, boolean>
  queues: Array<{ eventType: string; status: string; depth: number; oldestAt: string; maxAttempts: number }>
  deadLetters: Array<{
    id: string
    eventType: string
    attempts: number
    errorCode: string | null
    errorMessage: string
    createdAt: string
  }>
  bankTransfers: Array<{
    id: string
    externalId: string
    bookedAt: string
    amountCents: number
    currency: string
    reference: string
    reviewReason: string
  }>
  generatedAt: string
}

const { data, refresh, status: fetchStatus } = await useFetch<Operations>('/api/admin/operations')
const serverRuntime = useRuntimeConfig().public.serverRuntime
const cloudflare = serverRuntime === 'cloudflare'
const node = serverRuntime === 'node'
const toast = useToast()
const navigation = useAdminNavigation()
const { ready, loggedIn, user, session } = useUserSession()
const saving = ref(false)
const calendarPending = ref(false)
const communicationPending = ref(false)
const calendarEnabled = computed(() => {
  const capabilities = navigation.capabilities.value
  return (
    cloudflare &&
    ready.value &&
    loggedIn.value &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    navigation.status.value === 'ready' &&
    capabilities?.state === 'ready' &&
    capabilities.identityId === user.value?.id &&
    capabilities.sessionId === session.value?.sessionId &&
    capabilities.sessionVersion === session.value?.sessionVersion &&
    capabilities.permissions.includes('administration.manage')
  )
})
const calendarScope = computed(() =>
  calendarEnabled.value
    ? JSON.stringify([user.value?.id, session.value?.sessionId, session.value?.sessionVersion, '/admin/operaciones'])
    : ''
)
const trustedResponse = computed(() => node || (cloudflare && data.value?.source === 'cloudflare'))
const supportDestination = computed(
  () =>
    cloudflare &&
    trustedResponse.value &&
    navigation.status.value === 'ready' &&
    navigation.capabilities.value?.state === 'ready' &&
    navigation.capabilities.value.permissions.includes('support.manage')
)

function observed(key: string, availableInNode = false) {
  if (!trustedResponse.value) return false
  const capability = data.value?.capabilities?.[key]
  return capability === true || (node && capability === undefined && availableInNode)
}

// The Cloudflare adapter exposes aggregates only: even a hostile write/detail
// capability cannot manufacture bank, outbox or stock mutations in this page.
const canReconcile = computed(() => node && observed('bankTransfersReconcile', true))
const canReplay = computed(() => node && observed('deadLetterReplay', true))
const bankTransfersAvailable = computed(() => node && observed('bankTransfersPendingReview', true))
const deadLettersAvailable = computed(() => node && observed('deadLetters', true))
const queueDetailsAvailable = computed(() => node && observed('queueDetails', true))

const QUEUE_STATUS: Record<string, { label: string; tone: 'neutral' | 'warning' | 'danger' | 'info' }> = {
  pending: { label: 'En espera', tone: 'neutral' },
  processing: { label: 'Procesando', tone: 'info' },
  retry: { label: 'Reintentando', tone: 'warning' },
  dead: { label: 'Fallido', tone: 'danger' }
}

/**
 * Eventos de la cola que no son del ciclo del pedido y por tanto no están en
 * `ORDER_EVENT`. El identificador se sigue enseñando debajo: hace falta para buscar
 * en los registros.
 */
const OUTBOX_EVENT: Record<string, string> = {
  'identity.verification.requested': 'Verificación de identidad pendiente de enviar',
  'newsletter.confirmation.requested': 'Confirmación de suscripción pendiente de enviar',
  'invoice.issue.requested': 'Emisión de factura pendiente',
  'order.shipped': 'Aviso de salida del pedido',
  'order.delivered': 'Aviso de entrega',
  'support.ticket.created': 'Aviso de ticket de soporte',
  'privacy.request.created': 'Solicitud de privacidad pendiente'
}

const SUMMARY = [
  { key: 'queueDepth', label: 'En cola', icon: 'i-lucide-list-restart', bad: false },
  { key: 'deadLetters', label: 'Mensajes fallidos', icon: 'i-lucide-triangle-alert', bad: true },
  { key: 'bankTransfersPendingReview', label: 'Transferencias por conciliar', icon: 'i-lucide-landmark', bad: true },
  { key: 'staleRefunds', label: 'Reembolsos atascados', icon: 'i-lucide-banknote-x', bad: true },
  { key: 'fiscalExceptions', label: 'Facturas con incidencia', icon: 'i-lucide-file-warning', bad: true },
  { key: 'supportOverdue', label: 'Soporte fuera de plazo', icon: 'i-lucide-clock-alert', bad: true },
  {
    key: 'supportNextActionOverdue',
    label: 'Seguimientos de soporte vencidos',
    icon: 'i-lucide-calendar-clock',
    bad: true
  },
  { key: 'inventoryExceptions', label: 'Stock incoherente', icon: 'i-lucide-package-x', bad: true },
  { key: 'staleShipments', label: 'Envíos sin movimiento', icon: 'i-lucide-truck', bad: true },
  { key: 'communicationFailures', label: 'Correos rebotados', icon: 'i-lucide-mail-warning', bad: true },
  { key: 'emailDeliveryExceptions', label: 'Entrega de correos bloqueada', icon: 'i-lucide-mail-warning', bad: true }
]

const NODE_SUMMARY_KEYS = new Set(
  SUMMARY.filter((card) => !['emailDeliveryExceptions', 'supportNextActionOverdue'].includes(card.key)).map(
    (card) => card.key
  )
)
const INVENTORY_DIAGNOSTICS = [
  {
    key: 'inventoryReservationExpiryPending',
    label: 'Liberación pendiente',
    unit: 'reserva',
    units: 'reservas',
    warning: true,
    description:
      'Reservas que han vencido y siguen retenidas. Su liberación está pendiente; no implica por sí sola stock incoherente.'
  },
  {
    key: 'inventoryLedgerDivergences',
    label: 'Diferencias en el registro',
    unit: 'referencia',
    units: 'referencias',
    warning: true,
    description:
      'Saldos o reservas que no concuerdan con sus movimientos registrados, o reservas retenidas sin saldo verificable. Requieren revisión, no una corrección automática desde aquí.'
  },
  {
    key: 'inventoryAvailabilityDeficits',
    label: 'Reservas sin cobertura',
    unit: 'referencia',
    units: 'referencias',
    warning: true,
    description:
      'Reservas retenidas que superan la disponibilidad vendible tras bloqueos y stock de seguridad, sin backorder autorizado. Esa disponibilidad nunca baja de cero. Estar agotado sin reservas no es una incidencia.'
  },
  {
    key: 'inventoryStockExceptionOrders',
    label: 'Pedidos con excepción de stock',
    unit: 'pedido',
    units: 'pedidos',
    warning: true,
    description:
      'Pedidos con una excepción de stock registrada. Este recuento puede estar disponible aunque no pueda verificarse el diagnóstico del saldo.'
  },
  {
    key: 'inventoryBackorderCommitments',
    label: 'Compromiso permitido',
    unit: 'referencia',
    units: 'referencias',
    warning: false,
    description:
      'Referencias con backorder autorizado cuyos compromisos superan la disponibilidad vendible tras bloqueos y stock de seguridad. Es un compromiso permitido, no un error de stock, y se muestra aparte.'
  }
] as const
const inventoryAvailable = computed(() => INVENTORY_DIAGNOSTICS.some((card) => value(card.key) !== null))
const inventoryBalanceAvailable = computed(() => value('inventoryLedgerDivergences') !== null)

function value(key: string) {
  if (fetchStatus.value !== 'success' || !observed(key, NODE_SUMMARY_KEYS.has(key))) return null
  const count = data.value?.summary?.[key]
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null
}
function flagged(key: string) {
  const count = value(key)
  return count !== null && count > 0
}

/**
 * Trabajo antiguo que nadie ha tocado. Sin esto la pantalla enseña «En espera» junto a
 * «hace 20 días» y parece normal: lo que dice de verdad es que el consumidor está caído.
 */
const queueStalled = computed(
  () =>
    queueDetailsAvailable.value &&
    (data.value?.queues ?? []).some(
      (queue) =>
        queue.status === 'pending' &&
        queue.maxAttempts === 0 &&
        Date.now() - new Date(queue.oldestAt).getTime() > 24 * 3_600_000
    )
)

function generatedAtLabel() {
  const instant = data.value?.generatedAt
  if (fetchStatus.value !== 'success' || !trustedResponse.value || !instant || !Number.isFinite(Date.parse(instant)))
    return null
  return new Date(instant).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
}

function age(iso: string) {
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (hours < 1) return 'hace menos de 1 h'
  if (hours < 24) return `hace ${hours} h`
  return `hace ${Math.floor(hours / 24)} días`
}

/* --- Conciliación de transferencias --- */
const reconciling = ref<Operations['bankTransfers'][number] | null>(null)
const orderNumber = ref('')
const reconcileReason = ref('')

async function confirmReconcile() {
  const item = reconciling.value
  if (
    !canReconcile.value ||
    saving.value ||
    !item ||
    !orderNumber.value.trim() ||
    reconcileReason.value.trim().length < 3
  )
    return
  saving.value = true
  try {
    await $fetch(`/api/admin/operations/bank-transfers/${item.id}/reconcile`, {
      method: 'POST',
      body: { orderNumber: orderNumber.value.trim().toUpperCase(), reason: reconcileReason.value.trim() }
    })
    toast.add({
      title: `Transferencia conciliada con ${orderNumber.value.trim().toUpperCase()}`,
      color: 'success',
      icon: 'i-lucide-check'
    })
    reconciling.value = null
    orderNumber.value = ''
    reconcileReason.value = ''
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido conciliar'), color: 'error' })
  } finally {
    saving.value = false
  }
}

/* --- Replay de eventos muertos --- */
const retrying = ref<Operations['deadLetters'][number] | null>(null)
const retryReason = ref('')

async function confirmRetry() {
  const item = retrying.value
  if (!canReplay.value || saving.value || !item || retryReason.value.trim().length < 3) return
  saving.value = true
  try {
    await $fetch(`/api/admin/operations/outbox/${item.id}/retry`, {
      method: 'POST',
      body: { reason: retryReason.value.trim() }
    })
    toast.add({ title: 'Mensaje devuelto a la cola', color: 'success', icon: 'i-lucide-refresh-cw' })
    retrying.value = null
    retryReason.value = ''
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido reintentar'), color: 'error' })
  } finally {
    saving.value = false
  }
}

/* --- Apartados de la pantalla --- */
const tab = ref('summary')
const tabs = computed(() => [
  { value: 'summary', label: 'Resumen' },
  ...(node
    ? [
        { value: 'transfers', label: 'Transferencias', count: value('bankTransfersPendingReview') },
        { value: 'failed', label: 'Mensajes fallidos', count: value('deadLetters') }
      ]
    : []),
  { value: 'queue', label: 'Cola de envío', count: value('queueDepth') },
  ...(cloudflare
    ? [
        { value: 'calendar', label: 'Calendario de envíos' },
        { value: 'communications', label: 'Comunicaciones' }
      ]
    : [])
])
const dataTab = computed(() => !['calendar', 'communications'].includes(tab.value))
const eventLabel = (eventType: string) => ORDER_EVENT[eventType]?.label ?? OUTBOX_EVENT[eventType] ?? eventType

const TRANSFER_COLUMNS = [
  { key: 'amountCents', label: 'Importe' },
  { key: 'reference', label: 'Referencia recibida' },
  { key: 'bookedAt', label: 'Fecha' },
  { key: 'reviewReason', label: 'Por qué hay que revisarla' }
]
const FAILED_COLUMNS = [
  { key: 'eventType', label: 'Proceso' },
  { key: 'errorMessage', label: 'Error' },
  { key: 'attempts', label: 'Intentos', numeric: true },
  { key: 'createdAt', label: 'Antigüedad' }
]
const QUEUE_COLUMNS = [
  { key: 'eventType', label: 'Tarea' },
  { key: 'status', label: 'Estado' },
  { key: 'depth', label: 'En cola', numeric: true },
  { key: 'oldestAt', label: 'Más antiguo' },
  { key: 'maxAttempts', label: 'Intentos máx.', numeric: true, hideOnMobile: true }
]
</script>

<template>
  <AdminPage>
    <template #actions>
      <span v-if="generatedAtLabel()" class="adm-help self-center">Datos de las {{ generatedAtLabel() }}</span>
      <AdminButton icon="i-lucide-refresh-cw" :disabled="calendarPending || communicationPending" @click="refresh()">
        Actualizar
      </AdminButton>
    </template>
    <div class="adm-stack">
      <AdminTabs v-model="tab" :tabs="tabs" label="Apartados de procesos y colas" />

      <div v-if="cloudflare" v-show="tab === 'calendar'">
        <ShippingCalendarPanel
          :scope-key="calendarScope"
          :enabled="calendarEnabled"
          :pending="saving || communicationPending"
          @pending="calendarPending = $event"
        />
      </div>

      <div v-if="cloudflare" v-show="tab === 'communications'">
        <AdminCommunicationHistoryPanel
          :scope-key="calendarScope"
          :enabled="calendarEnabled"
          :pending="saving || calendarPending"
          @pending="communicationPending = $event"
        />
      </div>

      <div v-show="dataTab">
        <div
          v-if="fetchStatus === 'pending'"
          class="adm-card adm-table-skeleton"
          aria-busy="true"
          aria-label="Cargando operaciones"
        >
          <div v-for="n in 3" :key="n"><i /><i /><i /></div>
        </div>
        <AdminCard v-else-if="fetchStatus === 'error' || !data" flush>
          <AdminEmptyState
            role="alert"
            variant="error"
            title="No se han podido consultar las operaciones"
            description="No podemos confirmar el estado de colas ni incidencias. Comprueba tu sesión y vuelve a intentarlo."
          >
            <AdminButton icon="i-lucide-rotate-cw" @click="refresh()">Reintentar</AdminButton>
          </AdminEmptyState>
        </AdminCard>
        <template v-else>
          <!-- Resumen -->
          <div v-show="tab === 'summary'" class="adm-stack">
            <UAlert
              v-if="cloudflare"
              color="info"
              variant="subtle"
              icon="i-lucide-info"
              title="Resumen de operaciones en modo consulta"
              description="Aquí solo se consultan los recuentos. El calendario de envíos y las comunicaciones tienen su propio apartado y piden confirmación antes de guardar; desde esta pantalla no se ajusta stock, no se concilian cobros ni se reenvían mensajes."
            />
            <div class="adm-grid">
              <div
                v-for="card in SUMMARY"
                :key="card.key"
                :data-metric="card.key"
                class="adm-card adm-stat min-w-0"
                :class="card.bad && flagged(card.key) && 'border-amber-200'"
              >
                <div class="adm-stat__label">
                  <UIcon :name="card.icon" class="size-4 shrink-0" />
                  <span class="truncate">{{ card.label }}</span>
                </div>
                <p class="adm-stat__value">{{ value(card.key) ?? '—' }}</p>
                <p v-if="value(card.key) === null" class="adm-help mt-1">No disponible</p>
                <p v-if="cloudflare && card.key === 'supportOverdue'" class="adm-help mt-1">
                  Consultas abiertas cuyo plazo de respuesta ya ha vencido.
                </p>
                <p v-if="cloudflare && card.key === 'supportNextActionOverdue'" class="adm-help mt-1">
                  Consultas abiertas con un seguimiento comprometido que ya ha vencido.
                </p>
                <NuxtLink
                  v-if="
                    supportDestination &&
                    ['supportOverdue', 'supportNextActionOverdue'].includes(card.key) &&
                    value(card.key) !== null
                  "
                  to="/admin/soporte"
                  class="mt-2 inline-block text-[0.8125rem] font-semibold text-[var(--color-neteco-800)] underline"
                  >Ver expedientes de soporte</NuxtLink
                >
              </div>
            </div>
            <p v-if="cloudflare" class="adm-help">
              Los expedientes pueden aparecer en ambos recuentos; no se suman. Se excluyen los resueltos y cerrados.
            </p>

            <section class="adm-section" aria-labelledby="inventory-diagnostics-heading" data-inventory-diagnostics>
              <div class="adm-section__head">
                <div class="min-w-0">
                  <h2 id="inventory-diagnostics-heading" class="adm-section__title">Inventario del almacén</h2>
                  <p id="inventory-diagnostics-context" class="adm-help max-w-3xl">
                    Los recuentos no se suman: una referencia puede necesitar más de una revisión. Las reservas
                    caducadas y las ventas bajo pedido autorizadas se muestran separadas del stock incoherente. Solo
                    consulta, sin acciones de corrección.
                  </p>
                </div>
              </div>
              <AdminCard v-if="!inventoryAvailable" flush>
                <AdminEmptyState
                  compact
                  icon="i-lucide-package-search"
                  title="Diagnóstico detallado de inventario no disponible"
                  description="La consulta no permite distinguir reservas caducadas, divergencias de movimientos o déficit de disponibilidad. No podemos confirmar que esos estados sean cero."
                />
              </AdminCard>
              <template v-else>
                <p v-if="!inventoryBalanceAvailable" role="status" class="adm-help mb-3">
                  No hay una medición válida del saldo del almacén en esta consulta. Los recuentos no disponibles se
                  muestran como «—»; los pedidos con excepción de stock se contabilizan por separado.
                </p>
                <dl
                  class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
                  aria-describedby="inventory-diagnostics-context"
                >
                  <div
                    v-for="card in INVENTORY_DIAGNOSTICS"
                    :key="card.key"
                    :data-inventory-metric="card.key"
                    class="adm-card adm-stat min-w-0"
                    :class="card.warning && flagged(card.key) && 'border-amber-200'"
                  >
                    <dt class="adm-stat__label">{{ card.label }}</dt>
                    <dd class="adm-stat__value" :aria-describedby="`${card.key}-description`">
                      {{ value(card.key) ?? '—' }}
                      <span v-if="value(card.key) !== null" class="ml-1 text-xs font-normal text-[var(--text-muted)]">
                        {{ value(card.key) === 1 ? card.unit : card.units }}
                      </span>
                      <span v-else class="ml-1 text-xs font-normal text-[var(--text-muted)]">No disponible</span>
                    </dd>
                    <p :id="`${card.key}-description`" class="adm-help mt-2">
                      {{ card.description }}
                    </p>
                  </div>
                </dl>
              </template>
            </section>
          </div>

          <!-- Transferencias: es lo que cuesta dinero si no se hace -->
          <div v-if="node" v-show="tab === 'transfers'" class="adm-stack">
            <p class="adm-help">
              Ingresos recibidos que nadie ha casado con su pedido. Hasta que se concilien, el pedido sigue esperando
              cobro.
            </p>
            <AdminCard v-if="!bankTransfersAvailable" flush>
              <AdminEmptyState
                icon="i-lucide-landmark"
                title="Conciliación bancaria no disponible"
                description="Este entorno no observa ingresos bancarios ni permite conciliarlos. No podemos confirmar si hay transferencias pendientes."
              />
            </AdminCard>
            <AdminCard v-else-if="!data?.bankTransfers.length && value('bankTransfersPendingReview') === 0" flush>
              <AdminEmptyState
                icon="i-lucide-circle-check"
                title="No hay transferencias pendientes"
                description="Todos los ingresos recibidos están casados con su pedido."
              />
            </AdminCard>
            <AdminCard v-else-if="!data?.bankTransfers.length" flush>
              <AdminEmptyState
                title="Detalle de transferencias no disponible"
                description="La consulta no aporta un desglose de ingresos pendientes. No podemos confirmar que estén todos conciliados."
              />
            </AdminCard>
            <AdminTable
              v-else
              :rows="data.bankTransfers"
              :columns="TRANSFER_COLUMNS"
              :row-key="(row) => row.id"
              caption="Transferencias por conciliar"
            >
              <template #cell-amountCents="{ row }">
                <span class="font-semibold text-[var(--text-strong)]"
                  >{{ formatPrice(row.amountCents) }} {{ row.currency }}</span
                >
              </template>
              <template #cell-reference="{ row }">{{ row.reference || '—' }}</template>
              <template #cell-bookedAt="{ row }">{{ adminDate(row.bookedAt) }}</template>
              <template v-if="canReconcile" #actions="{ row }">
                <AdminButton
                  size="sm"
                  icon="i-lucide-link"
                  @click="((reconciling = row), (orderNumber = ''), (reconcileReason = ''))"
                >
                  Conciliar
                </AdminButton>
              </template>
            </AdminTable>
          </div>

          <!-- Mensajes fallidos -->
          <div v-if="node" v-show="tab === 'failed'" class="adm-stack">
            <p class="adm-help">
              Procesos que han agotado sus reintentos. Al devolverlos a la cola se vuelven a ejecutar desde el
              principio.
            </p>
            <AdminCard v-if="!deadLettersAvailable" flush>
              <AdminEmptyState
                icon="i-lucide-list-restart"
                title="Mensajes fallidos no disponibles"
                description="Este entorno no observa los mensajes fallidos ni permite reintentarlos."
              />
            </AdminCard>
            <AdminCard v-else-if="!data?.deadLetters.length && value('deadLetters') === 0" flush>
              <AdminEmptyState
                icon="i-lucide-circle-check"
                title="No hay mensajes fallidos"
                description="Ningún proceso automático ha agotado sus reintentos."
              />
            </AdminCard>
            <AdminCard v-else-if="!data?.deadLetters.length" flush>
              <AdminEmptyState
                title="Detalle de mensajes fallidos no disponible"
                description="La consulta no aporta un desglose. No podemos confirmar que ningún proceso haya agotado sus reintentos."
              />
            </AdminCard>
            <AdminTable
              v-else
              :rows="data.deadLetters"
              :columns="FAILED_COLUMNS"
              :row-key="(row) => row.id"
              caption="Mensajes fallidos"
            >
              <template #cell-eventType="{ row }">
                <span class="block font-semibold text-[var(--text-strong)]">{{ eventLabel(row.eventType) }}</span>
                <span class="adm-help block">{{ row.eventType }}</span>
              </template>
              <template #cell-errorMessage="{ row }">
                <span class="block max-w-xl">{{ row.errorMessage }}</span>
                <span class="adm-help block">{{ row.errorCode || 'Sin código de error' }}</span>
              </template>
              <template #cell-createdAt="{ row }">{{ age(row.createdAt) }}</template>
              <template v-if="canReplay" #actions="{ row }">
                <AdminButton size="sm" icon="i-lucide-refresh-cw" @click="((retrying = row), (retryReason = ''))">
                  Reintentar
                </AdminButton>
              </template>
            </AdminTable>
          </div>

          <!-- Cola de envío -->
          <div v-show="tab === 'queue'" class="adm-stack">
            <p class="adm-help">Lo que está pendiente de procesarse, agrupado por tipo de tarea.</p>
            <UAlert
              v-if="queueStalled"
              role="status"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="Hay trabajo en cola de hace más de un día que nadie ha intentado procesar todavía"
              description="Suele significar que el proceso que vacía la cola no está en marcha. Mientras siga así, los correos de confirmación y las facturas no salen."
            />
            <AdminCard v-if="!queueDetailsAvailable" flush>
              <AdminEmptyState
                icon="i-lucide-list-restart"
                title="Detalle de colas no disponible"
                :description="
                  value('queueDepth') === null
                    ? 'No se ha podido medir el trabajo pendiente.'
                    : `Hay ${value('queueDepth')} trabajos pendientes. El desglose por tipo, antigüedad e intentos no está disponible.`
                "
              />
            </AdminCard>
            <AdminCard v-else-if="!data?.queues.length && value('queueDepth') === 0" flush>
              <AdminEmptyState
                icon="i-lucide-circle-check"
                title="La cola está vacía"
                description="No hay nada pendiente de procesar."
              />
            </AdminCard>
            <AdminCard v-else-if="!data?.queues.length" flush>
              <AdminEmptyState
                title="Desglose de trabajo pendiente no disponible"
                description="El detalle de tareas está vacío, pero el recuento no confirma que la cola esté vacía."
              />
            </AdminCard>
            <AdminTable
              v-else
              :rows="data.queues"
              :columns="QUEUE_COLUMNS"
              :row-key="(row) => `${row.eventType}:${row.status}`"
              caption="Cola de envío"
            >
              <template #cell-eventType="{ row }">
                <span class="block font-semibold text-[var(--text-strong)]">{{ eventLabel(row.eventType) }}</span>
                <span class="adm-help block">{{ row.eventType }}</span>
              </template>
              <template #cell-status="{ row }">
                <AdminBadge :tone="(QUEUE_STATUS[row.status] ?? { tone: 'neutral' as const }).tone">
                  {{ (QUEUE_STATUS[row.status] ?? { label: adminHumanize(row.status) }).label }}
                </AdminBadge>
              </template>
              <template #cell-oldestAt="{ row }">{{ age(row.oldestAt) }}</template>
            </AdminTable>
          </div>
        </template>
      </div>

      <!-- Conciliar -->
      <UModal
        v-if="node"
        :open="Boolean(reconciling)"
        title="Conciliar la transferencia"
        @update:open="(value) => !value && (reconciling = null)"
      >
        <template #body>
          <div v-if="reconciling" class="adm adm-stack">
            <div class="rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3">
              <p class="text-base font-bold tabular-nums text-[var(--text-strong)]">
                {{ formatPrice(reconciling.amountCents) }} {{ reconciling.currency }}
              </p>
              <p class="adm-help mt-0.5">
                Recibida el {{ adminDate(reconciling.bookedAt) }} · referencia {{ reconciling.reference || '—' }}
              </p>
              <p class="adm-help mt-1">{{ reconciling.reviewReason }}</p>
            </div>

            <UFormField label="Número de pedido" required hint="El pedido al que corresponde este ingreso">
              <UInput v-model="orderNumber" class="w-full uppercase" placeholder="NE55E6D06533" />
            </UFormField>

            <UFormField
              label="Motivo"
              required
              hint="Queda en el registro contable"
              :error="
                reconcileReason.trim().length && reconcileReason.trim().length < 3 ? 'Al menos 3 caracteres.' : ''
              "
            >
              <UInput v-model="reconcileReason" class="w-full" placeholder="Cliente confirma el ingreso por teléfono" />
            </UFormField>

            <p class="adm-help">
              Solo se confirmará si el pedido, el importe, la moneda y la reserva siguen siendo válidos.
            </p>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="outline" @click="reconciling = null">Cancelar</UButton>
            <UButton
              :disabled="!canReconcile || !orderNumber.trim() || reconcileReason.trim().length < 3"
              :loading="saving"
              @click="confirmReconcile"
            >
              Conciliar
            </UButton>
          </div>
        </template>
      </UModal>

      <!-- Reintentar -->
      <UModal
        v-if="node"
        :open="Boolean(retrying)"
        title="Devolver el mensaje a la cola"
        @update:open="(value) => !value && (retrying = null)"
      >
        <template #body>
          <div v-if="retrying" class="adm adm-stack">
            <p class="font-semibold text-[var(--text-strong)]">{{ eventLabel(retrying.eventType) }}</p>
            <p class="adm-help">
              Falló {{ retrying.attempts }} {{ retrying.attempts === 1 ? 'vez' : 'veces' }} con «{{
                retrying.errorCode || 'sin código'
              }}». Se volverá a ejecutar desde el principio: comprueba antes que la causa esté resuelta.
            </p>
            <UFormField
              label="Motivo"
              required
              :error="retryReason.trim().length && retryReason.trim().length < 3 ? 'Al menos 3 caracteres.' : ''"
            >
              <UInput v-model="retryReason" class="w-full" placeholder="Proveedor de email ya restablecido" />
            </UFormField>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="outline" @click="retrying = null">Cancelar</UButton>
            <UButton :disabled="!canReplay || retryReason.trim().length < 3" :loading="saving" @click="confirmRetry">
              Reintentar
            </UButton>
          </div>
        </template>
      </UModal>
    </div>
  </AdminPage>
</template>
