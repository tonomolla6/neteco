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

const QUEUE_STATUS: Record<string, { label: string; color: 'neutral' | 'warning' | 'error' | 'info' }> = {
  pending: { label: 'En espera', color: 'neutral' },
  processing: { label: 'Procesando', color: 'info' },
  retry: { label: 'Reintentando', color: 'warning' },
  dead: { label: 'Muerto', color: 'error' }
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
  { key: 'deadLetters', label: 'Mensajes muertos', icon: 'i-lucide-triangle-alert', bad: true },
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
  { key: 'communicationFailures', label: 'Emails rebotados', icon: 'i-lucide-mail-warning', bad: true },
  { key: 'emailDeliveryExceptions', label: 'Entrega de emails bloqueada', icon: 'i-lucide-mail-warning', bad: true }
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
    toast.add({ title: 'Evento devuelto a la cola', color: 'success', icon: 'i-lucide-refresh-cw' })
    retrying.value = null
    retryReason.value = ''
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido reintentar'), color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <UiPageHeader
      title="Operaciones y colas"
      description="Trabajo asíncrono, excepciones y reintentos. Los datos sensibles de cada evento no se muestran."
    >
      <template #actions>
        <span v-if="generatedAtLabel()" class="self-center text-sm text-[var(--text-muted)]">
          {{ generatedAtLabel() }}
        </span>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          :disabled="calendarPending || communicationPending"
          @click="refresh()"
          >Actualizar</UButton
        >
      </template>
    </UiPageHeader>

    <UAlert
      v-if="cloudflare"
      class="mb-4"
      color="info"
      variant="subtle"
      icon="i-lucide-info"
      title="Resumen de operaciones en modo consulta"
      description="Los recuentos provienen de D1. Los paneles independientes de calendario y comunicaciones requieren permiso administrativo y confirmación; no permiten ajustes de stock, conciliación bancaria ni reenvíos ciegos."
    />

    <ShippingCalendarPanel
      v-if="cloudflare"
      :scope-key="calendarScope"
      :enabled="calendarEnabled"
      :pending="saving || communicationPending"
      class="mb-6"
      @pending="calendarPending = $event"
    />

    <AdminCommunicationHistoryPanel
      v-if="cloudflare"
      :scope-key="calendarScope"
      :enabled="calendarEnabled"
      :pending="saving || calendarPending"
      class="mb-6"
      @pending="communicationPending = $event"
    />

    <div v-if="fetchStatus === 'pending'" class="space-y-3" aria-busy="true" aria-label="Cargando operaciones">
      <div v-for="n in 3" :key="n" class="h-20 animate-pulse rounded bg-[var(--surface-sunken)]" />
    </div>
    <UiSurface v-else-if="fetchStatus === 'error' || !data" padding="none">
      <UiEmptyState
        variant="error"
        title="No se han podido consultar las operaciones"
        description="No podemos confirmar el estado de colas ni incidencias. Comprueba tu sesión y vuelve a intentarlo."
      >
        <UButton icon="i-lucide-refresh-cw" @click="refresh()">Reintentar</UButton>
      </UiEmptyState>
    </UiSurface>
    <template v-else>
      <!-- Contexto: el detalle accionable está debajo -->
      <div class="grid gap-3 grid-cols-1 sm:grid-cols-3 lg:grid-cols-5">
        <div
          v-for="card in SUMMARY"
          :key="card.key"
          :data-metric="card.key"
          class="rounded-[var(--radius-panel)] border bg-[var(--surface)] px-4 py-3"
          :class="card.bad && flagged(card.key) ? 'border-amber-200' : 'border-[var(--border)]'"
        >
          <div class="flex items-center gap-2 text-[var(--text-muted)]">
            <UIcon :name="card.icon" class="size-4" />
            <span class="truncate text-xs font-medium">{{ card.label }}</span>
          </div>
          <p
            class="tabular mt-1 font-display text-2xl font-bold"
            :class="card.bad && flagged(card.key) ? 'text-amber-900' : 'text-[var(--text-strong)]'"
          >
            {{ value(card.key) ?? '—' }}
          </p>
          <p v-if="value(card.key) === null" class="mt-1 text-xs text-[var(--text-muted)]">No disponible</p>
          <p v-if="cloudflare && card.key === 'supportOverdue'" class="mt-1 text-xs text-[var(--text-muted)]">
            Expedientes activos con plazo SLA anterior a esta consulta.
          </p>
          <p v-if="cloudflare && card.key === 'supportNextActionOverdue'" class="mt-1 text-xs text-[var(--text-muted)]">
            Expedientes activos con próxima acción comprometida anterior a esta consulta.
          </p>
          <NuxtLink
            v-if="
              supportDestination &&
              ['supportOverdue', 'supportNextActionOverdue'].includes(card.key) &&
              value(card.key) !== null
            "
            to="/admin/soporte"
            class="mt-2 inline-block text-xs underline"
            >Ver expedientes de soporte</NuxtLink
          >
        </div>
      </div>
      <p v-if="cloudflare" class="mt-3 text-sm text-[var(--text-muted)]">
        Los expedientes pueden aparecer en ambos recuentos; no se suman. Se excluyen los resueltos y cerrados.
      </p>

      <section class="mt-8" aria-labelledby="inventory-diagnostics-heading" data-inventory-diagnostics>
        <h2 id="inventory-diagnostics-heading" class="text-lg font-bold text-[var(--text-strong)]">
          Inventario del único almacén
        </h2>
        <p id="inventory-diagnostics-context" class="mt-1 mb-4 max-w-3xl text-sm text-[var(--text-muted)]">
          Los recuentos no se suman: una referencia puede necesitar más de una revisión. Las reservas caducadas y el
          backorder autorizado se muestran separados del stock incoherente. Sólo consulta, sin acciones de corrección.
        </p>
        <UiEmptyState
          v-if="!inventoryAvailable"
          title="Diagnóstico detallado de inventario no disponible"
          description="La consulta no permite distinguir reservas caducadas, divergencias de movimientos o déficit de disponibilidad. No podemos confirmar que esos estados sean cero."
        />
        <template v-else>
          <p v-if="!inventoryBalanceAvailable" role="status" class="mb-4 text-sm text-[var(--text-muted)]">
            No hay una medición válida del saldo del único almacén en esta consulta. Los recuentos no disponibles se
            muestran como «—»; los pedidos con excepción de stock se contabilizan por separado.
          </p>
          <dl
            class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            aria-describedby="inventory-diagnostics-context"
          >
            <div
              v-for="card in INVENTORY_DIAGNOSTICS"
              :key="card.key"
              :data-inventory-metric="card.key"
              class="min-w-0 rounded-[var(--radius-panel)] border bg-[var(--surface)] p-4"
              :class="card.warning && flagged(card.key) ? 'border-amber-200' : 'border-[var(--border)]'"
            >
              <dt class="text-sm font-semibold text-[var(--text-strong)]">{{ card.label }}</dt>
              <dd
                class="tabular mt-2 text-2xl font-bold text-[var(--text-strong)]"
                :aria-describedby="`${card.key}-description`"
              >
                {{ value(card.key) ?? '—' }}
                <span v-if="value(card.key) !== null" class="ml-1 text-xs font-normal text-[var(--text-muted)]">
                  {{ value(card.key) === 1 ? card.unit : card.units }}
                </span>
                <span v-else class="ml-1 text-xs font-normal text-[var(--text-muted)]">No disponible</span>
              </dd>
              <p :id="`${card.key}-description`" class="mt-2 text-xs text-[var(--text-muted)]">
                {{ card.description }}
              </p>
            </div>
          </dl>
        </template>
      </section>

      <!-- Transferencias: es lo que cuesta dinero si no se hace -->
      <section class="mt-8">
        <h2 class="pb-1 text-lg font-bold text-[var(--text-strong)]">Transferencias por conciliar</h2>
        <p class="pb-3 text-sm text-[var(--text-muted)]">
          Ingresos recibidos que nadie ha casado con su pedido. Hasta que se concilien, el pedido sigue esperando cobro.
        </p>

        <UiSurface padding="none">
          <UiEmptyState
            v-if="!bankTransfersAvailable"
            icon="i-lucide-landmark"
            title="Conciliación bancaria no disponible"
            description="Este entorno no observa ingresos bancarios ni permite conciliarlos. No podemos confirmar si hay transferencias pendientes."
          />
          <UiEmptyState
            v-else-if="!data?.bankTransfers.length && value('bankTransfersPendingReview') === 0"
            icon="i-lucide-circle-check"
            title="No hay transferencias pendientes"
            description="Todos los ingresos recibidos están casados con su pedido."
          />
          <UiEmptyState
            v-else-if="!data?.bankTransfers.length"
            title="Detalle de transferencias no disponible"
            description="La consulta no aporta un desglose de ingresos pendientes. No podemos confirmar que estén todos conciliados."
          />
          <ul v-else class="divide-y divide-[var(--border)]">
            <li v-for="item in data.bankTransfers" :key="item.id" class="flex flex-wrap items-center gap-4 px-4 py-3">
              <div class="min-w-0 flex-1">
                <p class="tabular font-semibold text-[var(--text-strong)]">
                  {{ formatPrice(item.amountCents) }} {{ item.currency }}
                </p>
                <p class="text-sm text-[var(--text-muted)]">
                  Referencia recibida: <span class="font-mono">{{ item.reference || '—' }}</span>
                </p>
                <p class="text-xs text-[var(--text-muted)]">
                  {{ new Date(item.bookedAt).toLocaleDateString('es-ES') }} · {{ item.reviewReason }}
                </p>
              </div>
              <UButton
                v-if="canReconcile"
                size="sm"
                color="neutral"
                variant="outline"
                icon="i-lucide-link"
                @click="((reconciling = item), (orderNumber = ''), (reconcileReason = ''))"
              >
                Conciliar
              </UButton>
            </li>
          </ul>
        </UiSurface>
      </section>

      <!-- Dead-letter -->
      <section class="mt-8">
        <h2 class="pb-1 text-lg font-bold text-[var(--text-strong)]">Mensajes muertos</h2>
        <p class="pb-3 text-sm text-[var(--text-muted)]">
          Procesos que han agotado sus reintentos. Al devolverlos a la cola se vuelven a ejecutar desde el principio.
        </p>

        <UiSurface padding="none">
          <UiEmptyState
            v-if="!deadLettersAvailable"
            icon="i-lucide-list-restart"
            title="Mensajes muertos no disponibles"
            description="Este entorno no observa la cola de mensajes muertos ni permite reintentarlos."
          />
          <UiEmptyState
            v-else-if="!data?.deadLetters.length && value('deadLetters') === 0"
            icon="i-lucide-circle-check"
            title="No hay mensajes muertos"
            description="Ningún proceso asíncrono ha agotado sus reintentos."
          />
          <UiEmptyState
            v-else-if="!data?.deadLetters.length"
            title="Detalle de mensajes muertos no disponible"
            description="La consulta no aporta un desglose. No podemos confirmar que ningún proceso haya agotado sus reintentos."
          />
          <ul v-else class="divide-y divide-[var(--border)]">
            <li v-for="item in data.deadLetters" :key="item.id" class="flex flex-wrap items-start gap-4 px-4 py-3">
              <div class="min-w-0 flex-1">
                <p class="font-mono text-sm font-semibold text-[var(--text-strong)]">{{ item.eventType }}</p>
                <p class="mt-0.5 text-sm text-red-700">{{ item.errorCode || 'Sin código de error' }}</p>
                <p class="mt-0.5 max-w-2xl text-xs text-[var(--text-muted)]">{{ item.errorMessage }}</p>
                <p class="mt-1 text-xs text-[var(--text-muted)]">
                  {{ item.attempts }} {{ item.attempts === 1 ? 'intento' : 'intentos' }} · {{ age(item.createdAt) }}
                </p>
              </div>
              <UButton
                v-if="canReplay"
                size="sm"
                color="neutral"
                variant="outline"
                icon="i-lucide-refresh-cw"
                @click="((retrying = item), (retryReason = ''))"
              >
                Reintentar
              </UButton>
            </li>
          </ul>
        </UiSurface>
      </section>

      <!-- Backlog -->
      <section class="mt-8">
        <h2 class="pb-1 text-lg font-bold text-[var(--text-strong)]">Cola de trabajo</h2>
        <p class="pb-3 text-sm text-[var(--text-muted)]">
          Lo que está pendiente de procesarse, agrupado por tipo de evento.
        </p>

        <p
          v-if="queueStalled"
          class="mb-3 flex items-start gap-2 rounded-[var(--radius-surface)] border border-[var(--ui-warning)]/30 bg-amber-50 p-3 text-sm text-[var(--text)]"
          role="status"
        >
          <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0 text-[var(--ui-warning)]" />
          <span>
            Hay trabajo en cola de hace más de un día que <b>nadie ha intentado procesar todavía</b>. Suele significar
            que el proceso que vacía la cola no está en marcha. Mientras siga así, los correos de confirmación y las
            facturas no salen.
          </span>
        </p>

        <UiSurface padding="none">
          <UiEmptyState
            v-if="!queueDetailsAvailable"
            icon="i-lucide-list-restart"
            title="Detalle de colas no disponible"
            :description="
              value('queueDepth') === null
                ? 'No se ha podido medir el trabajo pendiente.'
                : `Hay ${value('queueDepth')} trabajos pendientes medidos en D1. El desglose por evento, antigüedad e intentos no está disponible.`
            "
          />
          <UiEmptyState
            v-else-if="!data?.queues.length && value('queueDepth') === 0"
            icon="i-lucide-circle-check"
            title="La cola está vacía"
            description="No hay nada pendiente de procesar."
          />
          <UiEmptyState
            v-else-if="!data?.queues.length"
            title="Desglose de trabajo pendiente no disponible"
            description="El detalle de eventos está vacío, pero el recuento no confirma que la cola esté vacía."
          />
          <div v-else class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr
                  class="border-b border-[var(--border)] text-left text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
                >
                  <th class="px-4 py-3">Evento</th>
                  <th class="px-4 py-3">Estado</th>
                  <th class="px-4 py-3 text-right">En cola</th>
                  <th class="px-4 py-3">Más antiguo</th>
                  <th class="px-4 py-3 text-right">Intentos máx.</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--border)]">
                <tr v-for="queue in data.queues" :key="`${queue.eventType}:${queue.status}`">
                  <td class="px-4 py-2.5">
                    <span class="block font-medium text-[var(--text-strong)]">
                      {{ ORDER_EVENT[queue.eventType]?.label ?? OUTBOX_EVENT[queue.eventType] ?? queue.eventType }}
                    </span>
                    <span class="block font-mono text-[11px] text-[var(--text-muted)]">{{ queue.eventType }}</span>
                  </td>
                  <td class="px-4 py-2.5">
                    <UBadge :color="(QUEUE_STATUS[queue.status] ?? { color: 'neutral' }).color" variant="subtle">
                      {{ (QUEUE_STATUS[queue.status] ?? { label: queue.status }).label }}
                    </UBadge>
                  </td>
                  <td class="tabular px-4 py-2.5 text-right font-semibold">{{ queue.depth }}</td>
                  <td class="px-4 py-2.5 text-[var(--text-muted)]">{{ age(queue.oldestAt) }}</td>
                  <td class="tabular px-4 py-2.5 text-right text-[var(--text-muted)]">{{ queue.maxAttempts }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </UiSurface>
      </section>
    </template>

    <!-- Conciliar -->
    <UModal
      v-if="node"
      :open="Boolean(reconciling)"
      title="Conciliar la transferencia"
      @update:open="(value) => !value && (reconciling = null)"
    >
      <template #body>
        <div v-if="reconciling" class="space-y-4">
          <div class="rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3">
            <p class="tabular text-lg font-bold text-[var(--text-strong)]">
              {{ formatPrice(reconciling.amountCents) }} {{ reconciling.currency }}
            </p>
            <p class="mt-0.5 text-sm text-[var(--text-muted)]">
              Recibida el {{ new Date(reconciling.bookedAt).toLocaleDateString('es-ES') }} · referencia
              <span class="font-mono">{{ reconciling.reference || '—' }}</span>
            </p>
            <p class="mt-1 text-sm text-amber-800">{{ reconciling.reviewReason }}</p>
          </div>

          <UFormField label="Número de pedido" required hint="El pedido al que corresponde este ingreso">
            <UInput v-model="orderNumber" class="w-full font-mono uppercase" placeholder="NE55E6D06533" />
          </UFormField>

          <UFormField
            label="Motivo"
            required
            hint="Queda en la auditoría contable"
            :error="reconcileReason.trim().length && reconcileReason.trim().length < 3 ? 'Al menos 3 caracteres.' : ''"
          >
            <UInput v-model="reconcileReason" class="w-full" placeholder="Cliente confirma el ingreso por teléfono" />
          </UFormField>

          <p class="text-sm text-[var(--text-muted)]">
            Solo se confirmará si el pedido, el importe, la moneda y la reserva siguen siendo válidos.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="reconciling = null">Cancelar</UButton>
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
      title="Devolver el evento a la cola"
      @update:open="(value) => !value && (retrying = null)"
    >
      <template #body>
        <div v-if="retrying" class="space-y-4">
          <p class="font-mono text-sm font-semibold text-[var(--text-strong)]">{{ retrying.eventType }}</p>
          <p class="text-sm text-[var(--text-muted)]">
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
          <UButton color="neutral" variant="ghost" @click="retrying = null">Cancelar</UButton>
          <UButton :disabled="!canReplay || retryReason.trim().length < 3" :loading="saving" @click="confirmRetry">
            Reintentar
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
