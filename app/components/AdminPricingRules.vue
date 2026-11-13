<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface AutoDiscountRule {
  id: string
  name: string
  scope: string
  discountType: string
  discountValue: number
  priority: number
  stackable: boolean
  status: string
  version: number
}

interface FreeShippingRule {
  id: string
  name: string
  destinationZone: string
  minOrderGrossCents: number
  status: string
  version: number
}

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const busy = ref(false)

const activeTab = ref<string>('auto-discounts')
const discountRules = ref<AutoDiscountRule[]>([])
const shippingRules = ref<FreeShippingRule[]>([])

// New Discount Form
const discountName = ref('')
const discountScope = ref('basket')
const discountType = ref('percentage')
const discountValue = ref<number | ''>(10)
const discountPriority = ref(10)
const discountStackable = ref(false)

// New Free Shipping Form
const shippingName = ref('')
const shippingZone = ref('peninsula')
const shippingMinCents = ref<number | ''>(10000)

// Store Credit Form
const creditCustomerId = ref('')
const creditAmountCents = ref<number | ''>(2500)
const creditReason = ref('Compensación incidencia envío')

const tabs = computed(() => [
  { value: 'auto-discounts', label: 'Descuentos automáticos', count: discountRules.value.length },
  { value: 'free-shipping', label: 'Envío gratis', count: shippingRules.value.length },
  { value: 'store-credit', label: 'Saldo de tienda' }
])
const SCOPE_LABELS: Record<string, string> = {
  basket: 'Toda la cesta',
  category: 'Una categoría',
  product: 'Un producto',
  volume: 'Compras por volumen'
}
const scopeLabel = (code: string) => SCOPE_LABELS[code] ?? adminHumanize(code)
const ZONE_LABELS: Record<string, string> = {
  peninsula: 'Península',
  baleares: 'Baleares',
  canarias: 'Canarias',
  local: 'Zona de reparto propio'
}
const zoneLabel = (code: string) => ZONE_LABELS[code] ?? adminHumanize(code)
const ERROR_TEXTS: Record<string, string> = {
  forbidden: 'No tienes permiso para gestionar estas reglas.',
  unauthenticated: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
  mfa_required: 'Verifica el segundo paso de acceso para continuar.',
  invalid_input: 'Revisa los datos del formulario.',
  not_found: 'No hemos encontrado ese cliente o esa regla.',
  rate_limited: 'Demasiadas acciones seguidas. Espera un momento.',
  error_servidor: 'No se ha podido completar la operación. Vuelve a intentarlo.'
}
const errorText = (code: string) =>
  ERROR_TEXTS[code] ??
  (/^[a-z0-9_]+$/.test(code) ? 'No se ha podido completar la operación. Vuelve a intentarlo.' : code)

function errorMessage(caught: unknown): string {
  const code = (caught as { data?: { error?: { code?: string } } })?.data?.error?.code
  if (code) return code
  return caught instanceof Error ? caught.message : 'error_servidor'
}

function randomUuid(): string {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `rule-${Date.now()}`
}

async function loadRules() {
  loading.value = true
  error.value = null
  try {
    const [dRes, sRes] = await Promise.all([
      requestFetch<{ rules: AutoDiscountRule[] }>('/api/admin/pricing/auto-discounts'),
      requestFetch<{ rules: FreeShippingRule[] }>('/api/admin/pricing/free-shipping-rules')
    ])
    discountRules.value = dRes.rules ?? []
    shippingRules.value = sRes.rules ?? []
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    loading.value = false
  }
}

async function createDiscount() {
  if (!discountName.value.trim() || !discountValue.value) return
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const key = randomUuid()
    await requestFetch('/api/admin/pricing/auto-discounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': key
      },
      body: {
        name: discountName.value.trim(),
        scope: discountScope.value,
        discountType: discountType.value,
        discountValue: Number(discountValue.value),
        priority: Number(discountPriority.value),
        stackable: Boolean(discountStackable.value),
        status: 'draft'
      }
    })
    notice.value = `Regla de descuento "${discountName.value}" guardada con éxito.`
    discountName.value = ''
    await loadRules()
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function createShippingRule() {
  if (!shippingName.value.trim() || !shippingMinCents.value) return
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const key = randomUuid()
    await requestFetch('/api/admin/pricing/free-shipping-rules', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': key
      },
      body: {
        name: shippingName.value.trim(),
        destinationZone: shippingZone.value,
        minOrderGrossCents: Number(shippingMinCents.value),
        status: 'draft'
      }
    })
    notice.value = `Regla de envío gratis "${shippingName.value}" creada.`
    shippingName.value = ''
    await loadRules()
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function issueCredit() {
  if (!creditCustomerId.value.trim() || !creditAmountCents.value) return
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const key = randomUuid()
    await requestFetch('/api/admin/pricing/store-credit/issue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': key
      },
      body: {
        customerId: creditCustomerId.value.trim(),
        amountCents: Number(creditAmountCents.value),
        reason: creditReason.value.trim()
      }
    })
    notice.value = `Saldo de tienda añadido al cliente ${creditCustomerId.value}.`
    creditCustomerId.value = ''
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  loadRules()
})
</script>

<template>
  <div class="adm-stack">
    <UAlert
      v-if="notice"
      data-test="notice"
      role="status"
      aria-live="polite"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="notice"
    />
    <UAlert
      v-if="error"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorText(error)"
    >
      <template #actions>
        <button type="button" class="adm-btn adm-btn--secondary adm-btn--sm" :disabled="loading" @click="loadRules">
          Reintentar
        </button>
      </template>
    </UAlert>

    <AdminTabs v-model="activeTab" :tabs="tabs" label="Tipos de regla" />

    <!-- Descuentos automáticos -->
    <div v-if="activeTab === 'auto-discounts'" class="adm-stack">
      <AdminCard as="section" aria-labelledby="discount-list-heading" flush>
        <template #title><span id="discount-list-heading">Descuentos configurados</span></template>
        <div v-if="loading && !discountRules.length" class="adm-table-skeleton" role="status" aria-busy="true">
          <span class="sr-only">Cargando…</span>
          <div v-for="row in 3" :key="row"><i /><i /><i /><i /></div>
        </div>
        <AdminEmptyState
          v-else-if="discountRules.length === 0"
          compact
          icon="i-lucide-percent"
          title="No hay descuentos automáticos"
          description="Crea el primero con el formulario de abajo."
        />
        <div v-else class="adm-table-wrap">
          <table class="adm-table">
            <thead>
              <tr>
                <th scope="col">Nombre</th>
                <th scope="col">Se aplica a</th>
                <th scope="col" data-numeric>Descuento</th>
                <th scope="col" data-numeric>Prioridad</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in discountRules" :key="r.id">
                <td class="font-semibold text-[var(--text-strong)]">
                  {{ r.name }}
                  <AdminBadge v-if="r.stackable" plain class="ml-2">Acumulable</AdminBadge>
                </td>
                <td>{{ scopeLabel(r.scope) }}</td>
                <td data-numeric>
                  {{ r.discountType === 'percentage' ? `${r.discountValue}%` : `${r.discountValue} €` }}
                </td>
                <td data-numeric>{{ r.priority }}</td>
                <td><AdminBadge :status="r.status" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AdminCard
        as="section"
        aria-labelledby="new-discount-heading"
        description="Se guarda como borrador. Con prioridad más baja se aplica antes."
      >
        <template #title><span id="new-discount-heading">Nuevo descuento automático</span></template>
        <form class="adm-stack" @submit.prevent="createDiscount">
          <div class="adm-form-grid">
            <AdminFormField label="Nombre de la regla" for="discount-name" required>
              <input id="discount-name" v-model="discountName" data-test="discount-name" type="text" required />
            </AdminFormField>
            <AdminFormField label="Se aplica a" for="discount-scope">
              <select id="discount-scope" v-model="discountScope" data-test="discount-scope">
                <option value="basket">Toda la cesta</option>
                <option value="category">Una categoría</option>
                <option value="product">Un producto</option>
                <option value="volume">Compras por volumen</option>
              </select>
            </AdminFormField>
            <AdminFormField label="Tipo de descuento" for="discount-type">
              <select id="discount-type" v-model="discountType" data-test="discount-type">
                <option value="percentage">Porcentaje (%)</option>
                <option value="fixed">Importe fijo (€)</option>
              </select>
            </AdminFormField>
            <AdminFormField label="Valor" for="discount-value" required>
              <input
                id="discount-value"
                v-model.number="discountValue"
                data-test="discount-value"
                type="number"
                min="1"
                required
              />
            </AdminFormField>
            <AdminFormField label="Prioridad" for="discount-priority">
              <input id="discount-priority" v-model.number="discountPriority" type="number" min="1" />
            </AdminFormField>
            <label class="adm-check self-end">
              <input v-model="discountStackable" type="checkbox" /> Se puede acumular con otros descuentos
            </label>
          </div>
          <div class="flex justify-end">
            <button
              type="button"
              data-test="save-discount-btn"
              :disabled="busy || !discountName"
              class="adm-btn adm-btn--primary"
              @click="createDiscount"
            >
              Guardar regla de descuento
            </button>
          </div>
        </form>
      </AdminCard>
    </div>

    <!-- Envío gratis -->
    <div v-if="activeTab === 'free-shipping'" class="adm-stack">
      <AdminCard as="section" aria-labelledby="fs-list-heading" flush>
        <template #title><span id="fs-list-heading">Reglas de envío gratis</span></template>
        <div v-if="loading && !shippingRules.length" class="adm-table-skeleton" role="status" aria-busy="true">
          <span class="sr-only">Cargando…</span>
          <div v-for="row in 3" :key="row"><i /><i /><i /><i /></div>
        </div>
        <AdminEmptyState
          v-else-if="shippingRules.length === 0"
          compact
          icon="i-lucide-truck"
          title="No hay reglas de envío gratis"
          description="Crea la primera con el formulario de abajo."
        />
        <div v-else class="adm-table-wrap">
          <table class="adm-table">
            <thead>
              <tr>
                <th scope="col">Nombre</th>
                <th scope="col">Zona</th>
                <th scope="col" data-numeric>Pedido mínimo</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in shippingRules" :key="s.id">
                <td class="font-semibold text-[var(--text-strong)]">{{ s.name }}</td>
                <td>{{ zoneLabel(s.destinationZone) }}</td>
                <td data-numeric>{{ adminMoney(s.minOrderGrossCents) }}</td>
                <td><AdminBadge :status="s.status" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AdminCard as="section" aria-labelledby="shipping-heading" description="Se guarda como borrador.">
        <template #title><span id="shipping-heading">Nueva regla de envío gratis</span></template>
        <form class="adm-stack" @submit.prevent="createShippingRule">
          <div class="adm-form-grid">
            <AdminFormField label="Nombre de la regla" for="shipping-name" required>
              <input id="shipping-name" v-model="shippingName" type="text" required />
            </AdminFormField>
            <AdminFormField label="Zona de destino" for="shipping-zone">
              <select id="shipping-zone" v-model="shippingZone">
                <option value="peninsula">Península</option>
                <option value="baleares">Baleares</option>
                <option value="canarias">Canarias</option>
                <option value="local">Zona de reparto propio</option>
              </select>
            </AdminFormField>
            <AdminFormField
              label="Pedido mínimo (en céntimos)"
              for="shipping-min"
              :help="`Equivale a ${adminMoney(Number(shippingMinCents) || 0)}, impuestos incluidos.`"
              required
            >
              <input id="shipping-min" v-model.number="shippingMinCents" type="number" min="0" required />
            </AdminFormField>
          </div>
          <div class="flex justify-end">
            <button
              type="button"
              :disabled="busy || !shippingName"
              class="adm-btn adm-btn--primary"
              @click="createShippingRule"
            >
              Guardar regla de envío
            </button>
          </div>
        </form>
      </AdminCard>
    </div>

    <!-- Saldo de tienda -->
    <div v-if="activeTab === 'store-credit'" class="adm-stack">
      <AdminCard
        as="section"
        aria-labelledby="credit-heading"
        description="El cliente podrá gastar este saldo en sus próximos pedidos."
      >
        <template #title><span id="credit-heading">Dar saldo de tienda a un cliente</span></template>
        <form class="adm-stack" @submit.prevent="issueCredit">
          <div class="adm-form-grid">
            <AdminFormField label="Identificador del cliente" for="credit-customer" required>
              <input id="credit-customer" v-model="creditCustomerId" type="text" required />
            </AdminFormField>
            <AdminFormField
              label="Importe (en céntimos)"
              for="credit-amount"
              :help="`Equivale a ${adminMoney(Number(creditAmountCents) || 0)}.`"
              required
            >
              <input id="credit-amount" v-model.number="creditAmountCents" type="number" min="1" required />
            </AdminFormField>
            <AdminFormField label="Motivo" for="credit-reason">
              <input id="credit-reason" v-model="creditReason" type="text" />
            </AdminFormField>
          </div>
          <div class="flex justify-end">
            <button
              type="button"
              :disabled="busy || !creditCustomerId || !creditAmountCents"
              class="adm-btn adm-btn--primary"
              @click="issueCredit"
            >
              Dar saldo
            </button>
          </div>
        </form>
      </AdminCard>
    </div>
  </div>
</template>
