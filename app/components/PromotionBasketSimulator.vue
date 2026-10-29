<script setup lang="ts">
import type { PromotionRule } from '~~/shared/promotions'
import { promotionRuleSchema } from '~~/shared/promotions'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { adminCapabilitiesSchema } from '~~/shared/admin-navigation'
import { catalogPriceListSchema } from '~~/shared/catalog-price-commands'
import {
  promotionBasketPreviewInputSchema,
  promotionBasketPreviewResponseSchema,
  type PromotionBasketPreviewResponse
} from '~~/shared/promotion-basket-preview'
import { validateQuantity } from '~~/server/domain/money'

const props = defineProps<{ rule: PromotionRule | null; scopeKey: string; enabled: boolean; pending?: boolean }>()
const request = useRequestFetch(),
  navigation = useAdminNavigation(),
  runtime = useRuntimeConfig().public.serverRuntime
const { ready, loggedIn, user, session } = useUserSession()
const caps = computed(() => {
  const parsed = adminCapabilitiesSchema.safeParse(navigation.capabilities.value)
  return parsed.success ? parsed.data : null
})
const boundary = computed(() =>
  JSON.stringify([
    props.scopeKey,
    props.enabled,
    props.pending,
    runtime,
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    user.value?.mfaVerified,
    session.value?.sessionId,
    session.value?.sessionVersion,
    caps.value,
    navigation.status.value
  ])
)
const revoked = ref<string | null>(null)
const authorized = computed(
  () =>
    runtime === 'cloudflare' &&
    props.enabled &&
    !props.pending &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    navigation.status.value === 'ready' &&
    caps.value?.state === 'ready' &&
    caps.value.identityId === user.value.id &&
    caps.value.sessionId === session.value?.sessionId &&
    caps.value.sessionVersion === session.value?.sessionVersion &&
    caps.value.permissions.includes('administration.manage') &&
    caps.value.permissions.includes('catalog.write') &&
    revoked.value !== boundary.value
)
type PriceItem = ReturnType<typeof catalogPriceListSchema.parse>['items'][number]
type Selected = Pick<PriceItem, 'variantId' | 'sku' | 'product' | 'format' | 'quantityRules'> & { quantity: string }
const query = ref(''),
  appliedQuery = ref(''),
  choices = shallowRef<PriceItem[]>([]),
  pagination = ref({ page: 1, perPage: 25, total: 0, pages: 0 })
const selected = ref<Selected[]>([]),
  city = ref(''),
  postalCode = ref(''),
  customerId = ref('')
const lookupState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle'),
  lookupBusy = ref(false),
  previewBusy = ref(false),
  feedback = ref('')
const result = shallowRef<PromotionBasketPreviewResponse | null>(null)
const validRule = computed(() => {
  const parsed = promotionRuleSchema.safeParse(props.rule)
  return parsed.success ? parsed.data : null
})
let generation = 0,
  revision = 0,
  alive = true
const current = (owner: string, token: number) =>
  alive && authorized.value && owner === boundary.value && token === generation
function purge() {
  generation++
  revision++
  query.value = ''
  appliedQuery.value = ''
  choices.value = []
  selected.value = []
  city.value = ''
  postalCode.value = ''
  customerId.value = ''
  result.value = null
  feedback.value = ''
  pagination.value = { page: 1, perPage: 25, total: 0, pages: 0 }
  lookupState.value = 'idle'
  lookupBusy.value = false
  previewBusy.value = false
}
function authFailure(error: unknown, owner: string) {
  const e = error as { status?: number; statusCode?: number; response?: { status?: number } }
  if (owner === boundary.value && [401, 403].includes(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)) {
    purge()
    revoked.value = owner
    return true
  }
  return false
}
async function search(page = 1) {
  if (!authorized.value || lookupBusy.value) return
  const owner = boundary.value,
    token = generation
  if (page === 1) appliedQuery.value = query.value.trim()
  lookupBusy.value = true
  lookupState.value = 'loading'
  choices.value = []
  try {
    const parsed = catalogPriceListSchema.parse(
      await request('/api/admin/prices', {
        query: { q: appliedQuery.value, page, perPage: 25, historyPerPage: 1 },
        cache: 'no-store',
        retry: 0
      })
    )
    if (parsed.items.length > 25 || parsed.pagination.page !== page || parsed.pagination.perPage !== 25)
      throw Error('mismatched_picker')
    if (current(owner, token)) {
      choices.value = parsed.items
      pagination.value = parsed.pagination
      lookupState.value = 'ready'
    }
  } catch (error) {
    if (!authFailure(error, owner) && current(owner, token)) lookupState.value = 'error'
  } finally {
    if (current(owner, token)) lookupBusy.value = false
  }
}
function add(item: PriceItem) {
  if (!authorized.value || selected.value.some((line) => line.variantId === item.variantId)) return
  if (selected.value.length >= 100) {
    feedback.value = 'Máximo 100 variantes; no se ha truncado la selección.'
    return
  }
  selected.value.push({
    variantId: item.variantId,
    sku: item.sku,
    product: item.product,
    format: item.format,
    quantityRules: { ...item.quantityRules },
    quantity: String(item.quantityRules.minimumQuantity)
  })
}
function remove(id: string) {
  if (authorized.value) selected.value = selected.value.filter((line) => line.variantId !== id)
}
async function simulate() {
  if (!authorized.value || previewBusy.value || !validRule.value) return
  const owner = boundary.value,
    token = generation,
    edit = revision
  let input: ReturnType<typeof promotionBasketPreviewInputSchema.parse>
  try {
    input = promotionBasketPreviewInputSchema.parse({
      lines: selected.value.map((line) => {
        if (!/^[1-9]\d*$/.test(line.quantity)) throw Error('quantity')
        const quantity = Number(line.quantity)
        validateQuantity(quantity, line.quantityRules)
        return { variantId: line.variantId, quantity }
      }),
      destination: { city: city.value, postalCode: postalCode.value },
      customerId: customerId.value.trim() || null,
      rule: validRule.value
    })
  } catch {
    feedback.value = 'Revise cantidades (mínimo, incremento y máximo), destino e ID opcional del cliente.'
    return
  }
  previewBusy.value = true
  feedback.value = ''
  result.value = null
  try {
    const parsed = promotionBasketPreviewResponseSchema.parse(
      await request('/api/admin/promotions/basket-preview', {
        method: 'POST',
        body: input,
        cache: 'no-store',
        retry: 0
      })
    )
    const requestedQuantities = new Map(input.lines.map((line) => [line.variantId, line.quantity]))
    if (
      parsed.lines.length !== input.lines.length ||
      new Set(parsed.lines.map((line) => line.variantId)).size !== parsed.lines.length ||
      parsed.lines.some(
        (line, index) => line.lineIndex !== index || requestedQuantities.get(line.variantId) !== line.quantity
      )
    )
      throw Error('mismatched_basket')
    if (current(owner, token) && revision === edit) result.value = parsed
  } catch (error) {
    if (!authFailure(error, owner) && current(owner, token) && revision === edit)
      feedback.value = 'No se pudo simular. No hay resultado confirmado; vuelva a consultar expresamente.'
  } finally {
    if (current(owner, token)) previewBusy.value = false
  }
}
const scenarios = ['base', 'volume', 'proposed'] as const
const labels = { base: 'Base', volume: 'Volumen', proposed: 'Regla propuesta' }
const amount = (value: number | null) => (value === null ? 'Desconocido' : `${value} céntimos EUR`)
watch(
  [selected, city, postalCode, customerId, () => props.rule],
  () => {
    revision++
    result.value = null
    feedback.value = ''
  },
  { deep: true, flush: 'sync' }
)
watch(
  boundary,
  () => {
    purge()
    revoked.value = null
  },
  { flush: 'sync', immediate: true }
)
onBeforeUnmount(() => {
  alive = false
  purge()
})
</script>

<template>
  <section aria-label="Simulador de margen de mercancía" class="min-w-0 space-y-4 border rounded p-4">
    <h2>Simulación actual de cesta</h2>
    <p>No activa promociones ni acredita beneficio total o cotización.</p>
    <p>La regla propuesta se evalúa activa sólo para esta simulación; no acredita vigencia ni aprobación.</p>
    <p v-if="!authorized">Requiere autoridad vigente de administración y catálogo, email verificado y MFA.</p>
    <template v-else>
      <form data-testid="basket-search" class="flex flex-wrap items-end gap-3" @submit.prevent="search(1)">
        <label class="min-w-0 flex-1"
          >Buscar variante por producto o SKU<input
            v-model="query"
            data-testid="basket-query"
            maxlength="160"
            class="block w-full min-w-0 border rounded p-2"
        /></label>
        <button type="submit" :disabled="lookupBusy">Consultar variantes</button>
      </form>
      <p v-if="lookupState === 'loading'" role="status">Consultando variantes…</p>
      <p v-if="lookupState === 'error'" role="alert">
        No se pudo consultar el catálogo autorizado; no equivale a una lista vacía.
      </p>
      <template v-if="lookupState === 'ready'">
        <p>Búsqueda confirmada: {{ appliedQuery || 'todas las variantes' }}.</p>
        <p v-if="!choices.length">Sin coincidencias en la búsqueda confirmada.</p>
        <ul class="space-y-2">
          <li
            v-for="item in choices"
            :key="item.variantId"
            class="flex flex-wrap gap-2 items-center min-w-0 break-words"
          >
            <span class="min-w-0 [overflow-wrap:anywhere]"
              >{{ item.product }} · {{ item.sku }} · {{ item.format }}</span
            >
            <button
              type="button"
              :data-testid="`basket-add-${item.variantId}`"
              :disabled="selected.length >= 100 || selected.some((line) => line.variantId === item.variantId)"
              @click="add(item)"
            >
              Seleccionar {{ item.sku }}
            </button>
          </li>
        </ul>
        <nav aria-label="Páginas de variantes para simulación" class="flex flex-wrap gap-3">
          <button type="button" :disabled="lookupBusy || pagination.page <= 1" @click="search(pagination.page - 1)">
            Anterior
          </button>
          <span>Página {{ pagination.page }} · {{ pagination.total }} variantes</span>
          <button
            type="button"
            :disabled="lookupBusy || pagination.page >= pagination.pages"
            @click="search(pagination.page + 1)"
          >
            Siguiente
          </button>
        </nav>
      </template>
      <p>
        Cesta: {{ selected.length }} / 100 variantes. Los precios, costes, IVA, segmento y usos se consultan al servidor
        al simular.
      </p>
      <ul class="space-y-3">
        <li
          v-for="line in selected"
          :key="line.variantId"
          class="border rounded p-3 flex flex-wrap items-end gap-3 min-w-0"
        >
          <span class="min-w-0 [overflow-wrap:anywhere]">{{ line.product }} · {{ line.sku }} · {{ line.format }}</span>
          <label
            >Cantidad {{ line.sku
            }}<input
              v-model="line.quantity"
              :data-testid="`basket-quantity-${line.variantId}`"
              type="number"
              :min="line.quantityRules.minimumQuantity"
              :max="line.quantityRules.maximumQuantity ?? undefined"
              :step="line.quantityRules.quantityIncrement"
              class="block w-28 border rounded p-2"
          /></label>
          <span
            >Mínimo {{ line.quantityRules.minimumQuantity }} · incremento {{ line.quantityRules.quantityIncrement }} ·
            máximo {{ line.quantityRules.maximumQuantity ?? 'sin límite informado' }}</span
          >
          <button type="button" :data-testid="`basket-remove-${line.variantId}`" @click="remove(line.variantId)">
            Quitar {{ line.sku }}
          </button>
        </li>
      </ul>
      <div class="grid gap-3 sm:grid-cols-2 min-w-0">
        <label
          >Ciudad de destino<input
            v-model="city"
            data-testid="basket-city"
            maxlength="80"
            class="block w-full min-w-0 border rounded p-2"
        /></label>
        <label
          >Código postal<input
            v-model="postalCode"
            data-testid="basket-postal"
            inputmode="numeric"
            maxlength="5"
            class="block w-full min-w-0 border rounded p-2"
        /></label>
        <label class="sm:col-span-2"
          >ID interno del cliente (si se conoce, opcional)<input
            v-model="customerId"
            data-testid="basket-customer"
            maxlength="36"
            class="block w-full min-w-0 border rounded p-2"
        /></label>
      </div>
      <p>Vacío simula sin cliente. El buscador de empresas no proporciona este ID; no use el ID de una empresa.</p>
      <p v-if="!validRule">Complete una regla propuesta válida para simular.</p>
      <button data-testid="basket-run" type="button" :disabled="previewBusy || !validRule" @click="simulate">
        {{ previewBusy ? 'Simulando…' : 'Simular cesta sin guardar' }}
      </button>
      <p v-if="feedback" role="alert">{{ feedback }}</p>
      <section
        v-if="result"
        data-testid="basket-result"
        class="space-y-3 min-w-0"
        aria-label="Resultado confirmado de simulación"
      >
        <p>
          Datos actuales a <time :datetime="result.evaluatedAt">{{ result.evaluatedAt }}</time
          >. {{ result.eligible ? 'Regla aplicable en esta simulación' : 'Regla no aplicable: ' + result.reason }}.
        </p>
        <div class="overflow-x-auto max-w-full">
          <table class="w-full text-sm">
            <caption>
              Mercancía: importes en céntimos EUR; el margen usa ingresos y coste netos, sin logística.
            </caption>
            <thead>
              <tr>
                <th scope="col">Escenario</th>
                <th scope="col">Neto</th>
                <th scope="col">IVA</th>
                <th scope="col">Bruto</th>
                <th scope="col">Coste neto</th>
                <th scope="col">Margen neto mercancía</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="scenario in scenarios" :key="scenario">
                <th scope="row">{{ labels[scenario] }}</th>
                <td>{{ amount(result.totals[scenario].netCents) }}</td>
                <td>{{ amount(result.totals[scenario].taxCents) }}</td>
                <td>{{ amount(result.totals[scenario].grossCents) }}</td>
                <td :data-testid="scenario === 'proposed' ? 'basket-cost' : undefined">
                  {{ amount(result.totals[scenario].costNetCents) }}
                </td>
                <td :data-testid="scenario === 'proposed' ? 'basket-margin' : undefined">
                  {{ amount(result.totals[scenario].marginNetCents) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="result.totals.proposed.loss === true" role="alert">
          Pérdida de mercancía en la regla propuesta. No incluye costes logísticos.
        </p>
        <ul class="space-y-2">
          <li v-for="line in result.lines" :key="line.variantId" class="break-words [overflow-wrap:anywhere]">
            {{ line.name }} · {{ line.sku }} · {{ line.quantity }} unidades · coste unitario neto
            {{ amount(line.costUnitNetCents) }} · coste neto línea {{ amount(line.costNetCents) }} · bruto propuesto
            {{ amount(line.proposed.grossCents) }}
          </li>
        </ul>
        <h3>Portes: cargo al cliente, no coste operativo</h3>
        <p v-if="!result.shipping.options.length">No hay opciones de transporte para el contexto confirmado.</p>
        <ul>
          <li v-for="(option, index) in result.shipping.options" :key="index" class="break-words">
            Cargo al cliente · {{ option.methodCode }} / {{ option.serviceProfile }} · neto
            {{ amount(option.netCents) }} · IVA {{ amount(option.taxCents) }} · bruto {{ amount(option.grossCents) }}
          </li>
        </ul>
        <p>Coste logístico desconocido. Beneficio total no acreditado.</p>
      </section>
    </template>
  </section>
</template>
