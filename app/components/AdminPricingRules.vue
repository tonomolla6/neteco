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

const activeTab = ref<'auto-discounts' | 'free-shipping' | 'store-credit'>('auto-discounts')
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
    notice.value = `Saldo de tienda emitido a ${creditCustomerId.value}.`
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
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-bold text-slate-900">Reglas de precios y envío (PRI-014/017/018)</h1>
      <p class="text-sm text-slate-600">
        Gestión unificada de descuentos automáticos, envío gratis por margen/zona y emisión de crédito de tienda.
      </p>
    </header>

    <div
      v-if="notice"
      data-test="notice"
      role="status"
      aria-live="polite"
      class="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
    >
      {{ notice }}
    </div>

    <div v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      Error: {{ error }}
    </div>

    <!-- Navigation Tabs -->
    <div role="tablist" class="flex gap-2 border-b border-slate-200 pb-2">
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'auto-discounts'"
        class="rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
        :class="
          activeTab === 'auto-discounts' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
        "
        @click="activeTab = 'auto-discounts'"
      >
        Descuentos automáticos ({{ discountRules.length }})
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'free-shipping'"
        class="rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
        :class="
          activeTab === 'free-shipping' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
        "
        @click="activeTab = 'free-shipping'"
      >
        Reglas de envío gratis ({{ shippingRules.length }})
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'store-credit'"
        class="rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
        :class="
          activeTab === 'store-credit' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
        "
        @click="activeTab = 'store-credit'"
      >
        Crédito de tienda
      </button>
    </div>

    <!-- TAB 1: Auto Discounts -->
    <div v-if="activeTab === 'auto-discounts'" class="space-y-6">
      <section aria-labelledby="new-discount-heading" class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 id="new-discount-heading" class="text-base font-semibold text-slate-900">
          Nueva regla de descuento automático
        </h2>
        <form class="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3" @submit.prevent="createDiscount">
          <div>
            <label for="discount-name" class="block text-xs font-medium text-slate-700">Nombre de la regla</label>
            <input
              id="discount-name"
              v-model="discountName"
              data-test="discount-name"
              type="text"
              required
              class="mt-1 w-full rounded border p-1.5 text-sm"
            />
          </div>
          <div>
            <label for="discount-scope" class="block text-xs font-medium text-slate-700">Alcance</label>
            <select
              id="discount-scope"
              v-model="discountScope"
              data-test="discount-scope"
              class="mt-1 w-full rounded border p-1.5 text-sm"
            >
              <option value="basket">Cesta global</option>
              <option value="category">Categoría</option>
              <option value="product">Producto</option>
              <option value="volume">Volumen</option>
            </select>
          </div>
          <div>
            <label for="discount-type" class="block text-xs font-medium text-slate-700">Tipo</label>
            <select
              id="discount-type"
              v-model="discountType"
              data-test="discount-type"
              class="mt-1 w-full rounded border p-1.5 text-sm"
            >
              <option value="percentage">Porcentaje (%)</option>
              <option value="fixed">Importe fijo (EUR)</option>
            </select>
          </div>
          <div>
            <label for="discount-value" class="block text-xs font-medium text-slate-700">Valor</label>
            <input
              id="discount-value"
              v-model.number="discountValue"
              data-test="discount-value"
              type="number"
              min="1"
              required
              class="mt-1 w-full rounded border p-1.5 text-sm"
            />
          </div>
          <div>
            <label for="discount-priority" class="block text-xs font-medium text-slate-700">Prioridad</label>
            <input
              id="discount-priority"
              v-model.number="discountPriority"
              type="number"
              min="1"
              class="mt-1 w-full rounded border p-1.5 text-sm"
            />
          </div>
          <div class="flex items-center gap-2 pt-5">
            <label class="flex items-center gap-1 text-xs font-medium text-slate-700">
              <input v-model="discountStackable" type="checkbox" /> Acumulable (stackable)
            </label>
          </div>

          <div class="md:col-span-3 pt-2">
            <button
              type="button"
              data-test="save-discount-btn"
              :disabled="busy || !discountName"
              class="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              @click="createDiscount"
            >
              Guardar regla de descuento
            </button>
          </div>
        </form>
      </section>

      <!-- Rules list -->
      <section
        aria-labelledby="discount-list-heading"
        class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs space-y-4"
      >
        <h2 id="discount-list-heading" class="text-base font-semibold text-slate-900">Reglas configuradas</h2>
        <div v-if="discountRules.length === 0" class="text-xs text-slate-500 py-3">
          No hay reglas de descuento automático.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead class="bg-slate-50 font-medium text-slate-600">
              <tr>
                <th scope="col" class="px-3 py-2">Nombre</th>
                <th scope="col" class="px-3 py-2">Alcance</th>
                <th scope="col" class="px-3 py-2">Descuento</th>
                <th scope="col" class="px-3 py-2">Prioridad</th>
                <th scope="col" class="px-3 py-2">Estado</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="r in discountRules" :key="r.id" class="hover:bg-slate-50">
                <td class="px-3 py-2 font-medium text-slate-900">{{ r.name }}</td>
                <td class="px-3 py-2 text-slate-600">{{ r.scope }}</td>
                <td class="px-3 py-2 font-semibold text-slate-800">
                  {{ r.discountType === 'percentage' ? `${r.discountValue}%` : `${r.discountValue} €` }}
                </td>
                <td class="px-3 py-2 text-slate-600">{{ r.priority }}</td>
                <td class="px-3 py-2">
                  <span
                    class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    :class="r.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'"
                  >
                    {{ r.status }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <!-- TAB 2: Free Shipping -->
    <div v-if="activeTab === 'free-shipping'" class="space-y-6">
      <section aria-labelledby="shipping-heading" class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 id="shipping-heading" class="text-base font-semibold text-slate-900">Nueva regla de envío gratis</h2>
        <form class="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3" @submit.prevent="createShippingRule">
          <div>
            <label for="shipping-name" class="block text-xs font-medium text-slate-700">Nombre de la política</label>
            <input
              id="shipping-name"
              v-model="shippingName"
              type="text"
              required
              class="mt-1 w-full rounded border p-1.5 text-sm"
            />
          </div>
          <div>
            <label for="shipping-zone" class="block text-xs font-medium text-slate-700">Zona destino</label>
            <select id="shipping-zone" v-model="shippingZone" class="mt-1 w-full rounded border p-1.5 text-sm">
              <option value="peninsula">Península</option>
              <option value="baleares">Baleares</option>
              <option value="canarias">Canarias</option>
              <option value="local">Zona local propia</option>
            </select>
          </div>
          <div>
            <label for="shipping-min" class="block text-xs font-medium text-slate-700">Umbral mínimo (céntimos)</label>
            <input
              id="shipping-min"
              v-model.number="shippingMinCents"
              type="number"
              min="0"
              required
              class="mt-1 w-full rounded border p-1.5 text-sm"
            />
          </div>
          <div class="md:col-span-3 pt-2">
            <button
              type="button"
              :disabled="busy || !shippingName"
              class="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              @click="createShippingRule"
            >
              Guardar regla de envío
            </button>
          </div>
        </form>
      </section>

      <!-- Free shipping rules list -->
      <section
        aria-labelledby="fs-list-heading"
        class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs space-y-4"
      >
        <h2 id="fs-list-heading" class="text-base font-semibold text-slate-900">Políticas de envío gratis</h2>
        <div v-if="shippingRules.length === 0" class="text-xs text-slate-500 py-3">No hay reglas de envío gratis.</div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead class="bg-slate-50 font-medium text-slate-600">
              <tr>
                <th scope="col" class="px-3 py-2">Nombre</th>
                <th scope="col" class="px-3 py-2">Zona</th>
                <th scope="col" class="px-3 py-2">Mínimo pedido</th>
                <th scope="col" class="px-3 py-2">Estado</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="s in shippingRules" :key="s.id" class="hover:bg-slate-50">
                <td class="px-3 py-2 font-medium text-slate-900">{{ s.name }}</td>
                <td class="px-3 py-2 text-slate-600">{{ s.destinationZone }}</td>
                <td class="px-3 py-2 font-semibold text-slate-800">{{ (s.minOrderGrossCents / 100).toFixed(2) }} €</td>
                <td class="px-3 py-2">
                  <span
                    class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    :class="s.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'"
                  >
                    {{ s.status }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <!-- TAB 3: Store Credit -->
    <div v-if="activeTab === 'store-credit'" class="space-y-6">
      <section aria-labelledby="credit-heading" class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 id="credit-heading" class="text-base font-semibold text-slate-900">Emitir crédito de tienda a cliente</h2>
        <form class="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3" @submit.prevent="issueCredit">
          <div>
            <label for="credit-customer" class="block text-xs font-medium text-slate-700">UUID del Cliente</label>
            <input
              id="credit-customer"
              v-model="creditCustomerId"
              type="text"
              required
              class="mt-1 w-full rounded border p-1.5 text-sm"
            />
          </div>
          <div>
            <label for="credit-amount" class="block text-xs font-medium text-slate-700">Importe (céntimos)</label>
            <input
              id="credit-amount"
              v-model.number="creditAmountCents"
              type="number"
              min="1"
              required
              class="mt-1 w-full rounded border p-1.5 text-sm"
            />
          </div>
          <div>
            <label for="credit-reason" class="block text-xs font-medium text-slate-700">Motivo</label>
            <input
              id="credit-reason"
              v-model="creditReason"
              type="text"
              class="mt-1 w-full rounded border p-1.5 text-sm"
            />
          </div>
          <div class="md:col-span-3 pt-2">
            <button
              type="button"
              :disabled="busy || !creditCustomerId || !creditAmountCents"
              class="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              @click="issueCredit"
            >
              Emitir saldo
            </button>
          </div>
        </form>
      </section>
    </div>
  </div>
</template>
