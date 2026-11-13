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
    feedback.value = 'Máximo 100 productos en la cesta de prueba; no se ha añadido este.'
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
    feedback.value = 'Revise cantidades (mínimo, múltiplo y máximo), destino e identificador del cliente.'
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
      feedback.value = 'No se pudo simular. No hay ningún resultado: vuelve a calcular.'
  } finally {
    if (current(owner, token)) previewBusy.value = false
  }
}
const scenarios = ['base', 'volume', 'proposed'] as const
const labels = { base: 'Base', volume: 'Volumen', proposed: 'Regla propuesta' }
const amount = (value: number | null) => (value === null ? 'Desconocido' : adminMoney(value))
const SHIPPING_METHODS = { pickup: 'Recogida en tienda', own_delivery: 'Reparto propio', parcel: 'Mensajería' }
const SHIPPING_PROFILES = { parcel: 'paquete', pallet: 'palé', adr: 'mercancía peligrosa' }
const REASON_LABELS: Record<string, string> = {
  unavailable: 'la promoción no está disponible',
  not_started: 'todavía no ha empezado',
  expired: 'ya ha terminado',
  segment_not_eligible: 'el cliente no pertenece al grupo al que va dirigida',
  customer_required: 'hace falta un cliente registrado',
  usage_limit: 'se ha alcanzado el límite de usos',
  no_eligible_lines: 'ningún producto de la cesta entra en la promoción',
  no_benefit: 'el descuento resultante es cero'
}
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
  <section aria-label="Simulador de margen de mercancía" class="adm-stack min-w-0">
    <p class="adm-help">
      Prueba la promoción sobre una cesta con productos reales. No activa promociones ni cambia ningún pedido: la regla
      se da por activa solo para este cálculo.
    </p>
    <AdminEmptyState
      v-if="!authorized"
      compact
      icon="i-lucide-lock"
      title="Simulador no disponible"
      description="Hace falta permiso de administración y de catálogo, el correo verificado y la verificación en dos pasos."
    />
    <template v-else>
      <AdminCard
        title="Cesta de prueba"
        :description="`${selected.length} de 100 productos. Precios, costes e IVA se consultan al calcular.`"
      >
        <div class="adm-stack">
          <form data-testid="basket-search" class="adm-toolbar" role="search" @submit.prevent="search(1)">
            <label class="adm-toolbar__search">
              <span class="sr-only">Buscar por producto o referencia</span>
              <UIcon name="i-lucide-search" class="size-4" />
              <input
                v-model="query"
                data-testid="basket-query"
                type="search"
                maxlength="160"
                placeholder="Buscar por producto o referencia…"
              />
            </label>
            <button type="submit" class="adm-btn adm-btn--secondary adm-btn--sm" :disabled="lookupBusy">
              {{ lookupBusy ? 'Buscando…' : 'Buscar' }}
            </button>
          </form>
          <p v-if="lookupState === 'loading'" role="status" class="adm-help">Buscando productos…</p>
          <UAlert
            v-if="lookupState === 'error'"
            role="alert"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="No se pudo consultar el catálogo. Vuelve a buscar."
          />
          <template v-if="lookupState === 'ready'">
            <p v-if="!choices.length" class="adm-help">
              Sin coincidencias para «{{ appliedQuery || 'todos los productos' }}».
            </p>
            <template v-else>
              <p class="adm-help">Resultados para «{{ appliedQuery || 'todos los productos' }}»</p>
              <ul class="adm-list rounded-[var(--radius-control)] border border-[var(--border)]">
                <li v-for="item in choices" :key="item.variantId">
                  <div class="min-w-0 flex-1">
                    <p class="adm-list__title [overflow-wrap:anywhere]">{{ item.product }}</p>
                    <p class="adm-help [overflow-wrap:anywhere]">{{ item.sku }} · {{ item.format }}</p>
                  </div>
                  <button
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    :data-testid="`basket-add-${item.variantId}`"
                    :aria-label="`Añadir ${item.sku}`"
                    :disabled="selected.length >= 100 || selected.some((line) => line.variantId === item.variantId)"
                    @click="add(item)"
                  >
                    {{ selected.some((line) => line.variantId === item.variantId) ? 'Añadido' : 'Añadir' }}
                  </button>
                </li>
              </ul>
            </template>
            <nav
              v-if="pagination.pages > 1"
              aria-label="Páginas de variantes para simulación"
              class="flex flex-wrap items-center gap-2"
            >
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="lookupBusy || pagination.page <= 1"
                @click="search(pagination.page - 1)"
              >
                Anterior
              </button>
              <span class="adm-help">Página {{ pagination.page }} de {{ pagination.pages }}</span>
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="lookupBusy || pagination.page >= pagination.pages"
                @click="search(pagination.page + 1)"
              >
                Siguiente
              </button>
            </nav>
          </template>

          <ul v-if="selected.length" class="adm-list rounded-[var(--radius-control)] border border-[var(--border)]">
            <li v-for="line in selected" :key="line.variantId">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title [overflow-wrap:anywhere]">{{ line.product }}</p>
                <p class="adm-help [overflow-wrap:anywhere]">
                  {{ line.sku }} · {{ line.format }} · mínimo {{ line.quantityRules.minimumQuantity }}, de
                  {{ line.quantityRules.quantityIncrement }} en {{ line.quantityRules.quantityIncrement }}, máximo
                  {{ line.quantityRules.maximumQuantity ?? 'sin límite' }}
                </p>
              </div>
              <label class="adm-label flex items-center gap-2">
                <span
                  >Cantidad <span class="sr-only">de {{ line.sku }}</span></span
                >
                <input
                  v-model="line.quantity"
                  :data-testid="`basket-quantity-${line.variantId}`"
                  type="number"
                  :min="line.quantityRules.minimumQuantity"
                  :max="line.quantityRules.maximumQuantity ?? undefined"
                  :step="line.quantityRules.quantityIncrement"
                  class="adm-input w-24"
                />
              </label>
              <button
                type="button"
                class="adm-btn adm-btn--ghost adm-btn--sm adm-btn--icon"
                :data-testid="`basket-remove-${line.variantId}`"
                :aria-label="`Quitar ${line.sku}`"
                :title="`Quitar ${line.sku}`"
                @click="remove(line.variantId)"
              >
                <UIcon name="i-lucide-x" class="size-4" />
              </button>
            </li>
          </ul>
          <p v-else class="adm-help">Busca productos y añádelos a la cesta de prueba.</p>

          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Ciudad de destino">
              <input :id="id" v-model="city" data-testid="basket-city" maxlength="80" class="w-full" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Código postal">
              <input
                :id="id"
                v-model="postalCode"
                data-testid="basket-postal"
                inputmode="numeric"
                maxlength="5"
                class="w-full"
              />
            </AdminFormField>
          </div>
          <AdminFormField
            v-slot="{ id }"
            label="Identificador del cliente (opcional)"
            help="Vacío: se calcula sin cliente. Debe ser el identificador de un cliente, no el de una empresa."
          >
            <input :id="id" v-model="customerId" data-testid="basket-customer" maxlength="36" class="w-full" />
          </AdminFormField>
          <UAlert
            v-if="feedback"
            role="alert"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="feedback"
          />
        </div>
        <template #footer>
          <span v-if="!validRule" class="adm-help mr-auto">
            Completa primero los datos de la promoción para poder calcular.
          </span>
          <button
            data-testid="basket-run"
            type="button"
            class="adm-btn adm-btn--primary"
            :disabled="previewBusy || !validRule"
            @click="simulate"
          >
            {{ previewBusy ? 'Calculando…' : 'Calcular cesta sin guardar' }}
          </button>
        </template>
      </AdminCard>

      <section
        v-if="result"
        data-testid="basket-result"
        class="adm-stack min-w-0"
        aria-label="Resultado confirmado de simulación"
      >
        <AdminCard title="Resultado" flush>
          <template #actions>
            <AdminBadge :tone="result.eligible ? 'success' : 'warning'">
              {{
                result.eligible
                  ? 'La promoción se aplicaría'
                  : `No se aplicaría: ${REASON_LABELS[result.reason ?? ''] ?? 'no cumple las condiciones'}`
              }}
            </AdminBadge>
          </template>
          <div class="adm-table-wrap">
            <table class="adm-table">
              <caption class="sr-only">
                Mercancía: el margen compara ingresos y coste sin IVA, sin contar el transporte.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Precio aplicado</th>
                  <th scope="col" data-numeric>Sin IVA</th>
                  <th scope="col" data-numeric>IVA</th>
                  <th scope="col" data-numeric>Con IVA</th>
                  <th scope="col" data-numeric>Coste</th>
                  <th scope="col" data-numeric>Margen</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="scenario in scenarios" :key="scenario">
                  <th scope="row" class="text-left font-semibold">{{ labels[scenario] }}</th>
                  <td data-numeric>{{ amount(result.totals[scenario].netCents) }}</td>
                  <td data-numeric>{{ amount(result.totals[scenario].taxCents) }}</td>
                  <td data-numeric>{{ amount(result.totals[scenario].grossCents) }}</td>
                  <td data-numeric :data-testid="scenario === 'proposed' ? 'basket-cost' : undefined">
                    {{ amount(result.totals[scenario].costNetCents) }}
                  </td>
                  <td data-numeric :data-testid="scenario === 'proposed' ? 'basket-margin' : undefined">
                    {{ amount(result.totals[scenario].marginNetCents) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <template #footer>
            <span class="adm-help mr-auto">
              Calculado el <time :datetime="result.evaluatedAt">{{ adminDate(result.evaluatedAt, true) }}</time
              >. Coste logístico desconocido. Beneficio total no acreditado: el margen solo cuenta la mercancía.
            </span>
          </template>
        </AdminCard>
        <UAlert
          v-if="result.totals.proposed.loss === true"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Pérdida de mercancía con esta promoción"
          description="Se vendería por debajo del coste, y eso sin contar el transporte."
        />
        <AdminCard title="Detalle por producto" flush>
          <ul class="adm-list">
            <li v-for="line in result.lines" :key="line.variantId">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title [overflow-wrap:anywhere]">{{ line.name }}</p>
                <p class="adm-help [overflow-wrap:anywhere]">
                  {{ line.sku }} · {{ line.quantity }} unidades · coste por unidad {{ amount(line.costUnitNetCents) }} ·
                  coste total {{ amount(line.costNetCents) }}
                </p>
              </div>
              <span class="font-semibold text-[var(--text-strong)] tabular-nums">
                {{ amount(line.proposed.grossCents) }}
              </span>
            </li>
          </ul>
        </AdminCard>
        <AdminCard
          title="Portes"
          description="Cargo al cliente por el envío; no es lo que le cuesta el transporte a la tienda."
          flush
        >
          <AdminEmptyState
            v-if="!result.shipping.options.length"
            compact
            icon="i-lucide-truck"
            title="No hay opciones de envío para este destino"
          />
          <ul v-else class="adm-list">
            <li v-for="(option, index) in result.shipping.options" :key="index">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title [overflow-wrap:anywhere]">
                  {{ SHIPPING_METHODS[option.methodCode] }} · {{ SHIPPING_PROFILES[option.serviceProfile] }}
                </p>
                <p class="adm-help">Sin IVA {{ amount(option.netCents) }} · IVA {{ amount(option.taxCents) }}</p>
              </div>
              <span class="font-semibold text-[var(--text-strong)] tabular-nums">{{ amount(option.grossCents) }}</span>
            </li>
          </ul>
        </AdminCard>
      </section>
    </template>
  </section>
</template>
