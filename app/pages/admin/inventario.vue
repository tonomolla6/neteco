<script setup lang="ts">
import {
  inventoryLegacyIdSchema,
  adminInventoryVariantSchema,
  adminInventoryVariantSearchSchema,
  inventoryVariantSearchInputSchema,
  type AdminInventoryVariantSearch,
  type AdminInventoryVariant
} from '~~/shared/inventory-commands'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import InventoryAlertsPanel from '~/components/InventoryAlertsPanel.vue'
import InventoryCountImportPanel from '~/components/InventoryCountImportPanel.vue'
import InventoryLotsCostingForecastPanel from '~/components/InventoryLotsCostingForecastPanel.vue'
import InventoryOperationsPanel from '~/components/InventoryOperationsPanel.vue'
definePageMeta({ layout: 'default', middleware: 'auth' })
useSeoMeta({ title: 'Inventario · Admin', robots: 'noindex, nofollow, noarchive' })
const { ready, loggedIn, user, session } = useUserSession(),
  runtime = useRuntimeConfig().public.serverRuntime
const navigation = useAdminNavigation()
const route = useRoute()
const legacyId = ref(''),
  searchText = ref(''),
  searchPage = ref(1),
  searchResults = shallowRef<AdminInventoryVariantSearch | null>(null),
  selectedId = ref(''),
  data = shallowRef<AdminInventoryVariant | null>(null),
  contextIdentity = shallowRef<{ variantId: number; variantUuid: string; operatorId: string } | null>(null),
  busy = ref(false),
  operationPending = ref(false),
  alertsPending = ref(false),
  countImportPending = ref(false),
  message = ref(''),
  page = ref(1)
// Estado de interfaz: pestaña local y panel lateral de la ficha de existencias.
const tab = ref('existencias'),
  drawerOpen = ref(false)
const inventoryTabs = [
  { value: 'existencias', label: 'Existencias' },
  { value: 'alertas', label: 'Alertas' },
  { value: 'recuentos', label: 'Recuentos' },
  { value: 'lotes', label: 'Lotes y costes' },
  { value: 'reservas', label: 'Reservas y ubicaciones' }
]
const stockColumns = [
  { key: 'name', label: 'Producto' },
  { key: 'sku', label: 'Referencia' },
  { key: 'unitLabel', label: 'Unidad', hideOnMobile: true }
]
// El panel no se cierra mientras haya un ajuste a medio confirmar: cerrarlo lo descartaría.
const detailOpen = computed({
  get: () => drawerOpen.value,
  set: (value: boolean) => {
    if (!value && operationPending.value) return
    drawerOpen.value = value
  }
})
function stockState(balance: AdminInventoryVariant['balance']): {
  label: string
  tone: 'success' | 'warning' | 'danger'
} {
  if (balance.sellableQuantity <= 0) return { label: 'Sin stock', tone: 'danger' }
  if (balance.safetyStock > 0 && balance.physicalQuantity <= balance.safetyStock)
    return { label: 'Stock bajo', tone: 'warning' }
  return { label: 'En stock', tone: 'success' }
}
const operatorId = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
const scopeKey = computed(() =>
  JSON.stringify([
    loggedIn.value,
    operatorId.value,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
function purge() {
  generation++
  busy.value = operationPending.value = alertsPending.value = countImportPending.value = false
  data.value = searchResults.value = null
  contextIdentity.value = null
  legacyId.value = searchText.value = selectedId.value = message.value = ''
  page.value = searchPage.value = 1
}
let active = true,
  generation = 0
onBeforeUnmount(() => {
  purge()
  active = false
  generation++
})
function authorize() {
  const caps = navigation.capabilities.value
  return (
    runtime === 'cloudflare' &&
    active &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    catalogPolicyUuidSchema.safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    navigation.status.value === 'ready' &&
    caps?.state === 'ready' &&
    caps.identityId === operatorId.value &&
    caps.sessionId === session.value?.sessionId &&
    caps.sessionVersion === session.value?.sessionVersion &&
    caps.permissions.includes('inventory.read') &&
    catalogPolicyUuidSchema.safeParse(operatorId.value).success
  )
}
function authorizeInventoryOperation() {
  return authorize() && !alertsPending.value && !countImportPending.value
}
async function refreshAfterCountImport() {
  if (!data.value || !authorize() || busy.value) return
  busy.value = true
  try {
    await reload()
  } catch {
    data.value = null
    message.value =
      'No hemos podido actualizar las existencias del producto después del recuento. Vuelve a consultarlo.'
  } finally {
    busy.value = false
  }
}
async function reload(): Promise<unknown> {
  if (!authorize() || !inventoryLegacyIdSchema.safeParse(selectedId.value).success) {
    data.value = null
    throw new Error('inventory_authority_unconfirmed')
  }
  const identity = operatorId.value,
    id = selectedId.value,
    epoch = generation,
    requestedPage = page.value
  const current = () =>
    active && generation === epoch && authorize() && operatorId.value === identity && selectedId.value === id
  let response: unknown
  try {
    response = await $fetch(`/api/admin/inventory/variants/${id}`, {
      query: { page: requestedPage, perPage: 25 }
    })
  } catch (failure) {
    if (current()) data.value = null
    throw failure
  }
  if (!current()) throw new Error('inventory_authority_unconfirmed')
  const parsed = adminInventoryVariantSchema.safeParse(response)
  if (
    !parsed.success ||
    !authorize() ||
    operatorId.value !== identity ||
    selectedId.value !== id ||
    parsed.data.variant.id !== Number(id) ||
    parsed.data.ledger.pagination.page !== requestedPage ||
    parsed.data.ledger.pagination.perPage !== 25
  ) {
    data.value = null
    throw new Error('inventory_authority_unconfirmed')
  }
  data.value = parsed.data
  contextIdentity.value = {
    variantId: parsed.data.variant.id,
    variantUuid: parsed.data.variant.uuid,
    operatorId: identity
  }
  return parsed.data
}
async function load() {
  if (busy.value || operationPending.value || alertsPending.value || countImportPending.value || !authorize()) return
  message.value = ''
  data.value = null
  contextIdentity.value = null
  generation++
  const epoch = generation
  if (!inventoryLegacyIdSchema.safeParse(legacyId.value).success) {
    message.value = 'Escribe el número interno del producto, solo cifras y sin ceros delante.'
    return
  }
  selectedId.value = legacyId.value
  page.value = 1
  busy.value = true
  try {
    await reload()
  } catch {
    if (!active || generation !== epoch) return
    message.value =
      'No hemos podido cargar las existencias de este producto. Comprueba tu sesión y vuelve a intentarlo.'
  } finally {
    if (active && generation === epoch) busy.value = false
  }
}
async function search(delta = 0) {
  if (busy.value || operationPending.value || alertsPending.value || countImportPending.value || !authorize()) return
  const requestedPage = delta ? searchPage.value + delta : 1,
    query = inventoryVariantSearchInputSchema.safeParse({ q: searchText.value, page: requestedPage, perPage: 25 })
  if (!query.success) {
    message.value = 'Escribe entre 2 y 100 caracteres del nombre o de la referencia.'
    searchResults.value = null
    return
  }
  const identity = operatorId.value,
    q = query.data.q,
    epoch = generation
  busy.value = true
  message.value = ''
  try {
    const raw: unknown = await $fetch('/api/admin/inventory/variants', { query: query.data }),
      parsed = adminInventoryVariantSearchSchema.safeParse(raw)
    if (
      !parsed.success ||
      !active ||
      generation !== epoch ||
      !authorize() ||
      operatorId.value !== identity ||
      searchText.value.trim() !== q ||
      parsed.data.pagination.page !== requestedPage ||
      parsed.data.pagination.perPage !== 25
    )
      throw new Error('inventory_search_unconfirmed')
    searchResults.value = parsed.data
    searchPage.value = requestedPage
  } catch {
    if (!active || generation !== epoch) return
    searchResults.value = null
    message.value =
      'No se ha podido confirmar la búsqueda privada. Vuelve a intentarlo: no significa que no haya productos.'
  } finally {
    if (active && generation === epoch) busy.value = false
  }
}
async function selectVariant(id: number) {
  if (busy.value || operationPending.value || alertsPending.value || countImportPending.value || !authorize()) return
  legacyId.value = String(id)
  await load()
}
async function openVariant(id: number) {
  await selectVariant(id)
  if (data.value?.variant.id === id) drawerOpen.value = true
}
async function openVariantFromAlert(id: number) {
  tab.value = 'existencias'
  await openVariant(id)
}
async function lookup() {
  await load()
  if (data.value) drawerOpen.value = true
}
async function movePage(delta: number) {
  if (busy.value || operationPending.value || alertsPending.value || countImportPending.value || !data.value) return
  page.value += delta
  busy.value = true
  message.value = ''
  const epoch = generation
  try {
    await reload()
  } catch {
    if (!active || generation !== epoch) return
    data.value = null
    message.value = 'No hemos podido cargar esta página de movimientos. Vuelve a intentarlo.'
  } finally {
    if (active && generation === epoch) busy.value = false
  }
}
watch(scopeKey, purge, { flush: 'sync' })
watch(contextIdentity, (value) => {
  if (!value) drawerOpen.value = false
})
let consumedVariantLink = ''
watch(
  () => [
    route.query.variantId,
    scopeKey.value,
    authorize(),
    operationPending.value,
    alertsPending.value,
    countImportPending.value,
    busy.value
  ],
  () => {
    const raw = route.query.variantId
    if (!authorize() || busy.value || operationPending.value || alertsPending.value || countImportPending.value) return
    const parsed = inventoryLegacyIdSchema.safeParse(raw)
    if (!parsed.success) {
      consumedVariantLink = ''
      return
    }
    const link = scopeKey.value + ':' + parsed.data
    if (consumedVariantLink === link) return
    consumedVariantLink = link
    void openVariant(Number(parsed.data))
  },
  { immediate: true, flush: 'post' }
)
watch(
  () => [
    ready.value,
    loggedIn.value,
    operatorId.value,
    user.value?.mfaVerified,
    navigation.status.value,
    navigation.capabilities.value
  ],
  () => {
    generation++
    busy.value = false
    data.value = null
    searchResults.value = null
    const caps = navigation.capabilities.value
    if (
      navigation.status.value === 'ready' &&
      caps &&
      (caps.state === 'forbidden' || (caps.state === 'ready' && !caps.permissions.includes('inventory.read')))
    ) {
      purge()
      return
    }
    // Temporary readiness/MFA loss for the SAME logged-in operator hides all
    // facts and actions, but must not discard a possibly committed intent.
    if (
      !loggedIn.value ||
      !catalogPolicyUuidSchema.safeParse(operatorId.value).success ||
      (contextIdentity.value && contextIdentity.value.operatorId !== operatorId.value)
    ) {
      operationPending.value = false
      contextIdentity.value = null
      selectedId.value = ''
    }
  },
  { flush: 'sync' }
)
</script>
<template>
  <AdminPage>
    <template v-if="runtime === 'cloudflare'" #actions>
      <AdminButton variant="primary" icon="i-lucide-upload" @click="tab = 'recuentos'">Importar recuento</AdminButton>
    </template>
    <div class="adm-stack">
      <UAlert
        v-if="runtime !== 'cloudflare'"
        role="status"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="El inventario no está disponible en esta instalación"
        description="Esta pantalla solo funciona en la tienda publicada."
      />
      <template v-else>
        <AdminTabs v-model="tab" :tabs="inventoryTabs" label="Apartados de inventario" />

        <div v-show="tab === 'existencias'" class="adm-stack">
          <UAlert
            v-if="message"
            role="status"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="message"
          />
          <AdminTable
            :rows="searchResults?.items ?? []"
            :columns="stockColumns"
            :row-key="(row) => row.uuid"
            :status="busy ? 'pending' : 'idle'"
            :total="searchResults?.pagination.total ?? 0"
            :per-page="25"
            :page="searchPage"
            empty-icon="i-lucide-search"
            :empty-title="searchResults ? 'Ningún producto coincide con la búsqueda' : 'Busca un producto'"
            :empty-description="
              searchResults
                ? 'Prueba con otro nombre o con la referencia completa.'
                : 'Escribe al menos dos letras del nombre o de la referencia para ver sus existencias y ajustar el stock.'
            "
            caption="Productos encontrados"
            @update:page="search($event - searchPage)"
          >
            <template #toolbar>
              <form
                class="adm-toolbar"
                role="search"
                aria-label="Seleccionar variante por SKU o nombre"
                @submit.prevent="search()"
              >
                <label class="adm-toolbar__search">
                  <span class="sr-only">Buscar por nombre o referencia</span>
                  <UIcon name="i-lucide-search" class="size-4" />
                  <input
                    v-model="searchText"
                    type="search"
                    data-testid="inventory-search"
                    data-slot="adm-search"
                    maxlength="100"
                    placeholder="Buscar por nombre o referencia"
                    :disabled="busy || operationPending || alertsPending || countImportPending"
                  />
                </label>
                <button
                  type="submit"
                  class="adm-btn adm-btn--secondary"
                  data-testid="search-inventory"
                  :disabled="busy || operationPending || alertsPending || countImportPending || !authorize()"
                >
                  Buscar
                </button>
                <div v-if="data" class="adm-toolbar__end">
                  <span class="adm-help">Último consultado: {{ data.variant.sku }}</span>
                  <AdminBadge :tone="stockState(data.balance).tone">{{ stockState(data.balance).label }}</AdminBadge>
                  <AdminButton size="sm" :disabled="!contextIdentity" @click="drawerOpen = true">
                    Ver existencias
                  </AdminButton>
                </div>
              </form>
            </template>
            <template #cell-name="{ row }">
              <span class="font-semibold text-[var(--text-strong)]">{{ row.name }}</span>
            </template>
            <template #cell-unitLabel="{ row }">{{ row.unitLabel }} ({{ row.unitBase }})</template>
            <template #actions="{ row }">
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                data-testid="choose-inventory-variant"
                :disabled="busy || operationPending || alertsPending || countImportPending || !authorize()"
                @click="openVariant(row.id)"
              >
                Ver existencias
              </button>
            </template>
          </AdminTable>
          <details class="adm-help">
            <summary class="cursor-pointer">Buscar por número interno del producto</summary>
            <form class="adm-toolbar mt-3" @submit.prevent="lookup">
              <label class="adm-field">
                <span class="sr-only">Número interno del producto</span>
                <input
                  v-model="legacyId"
                  data-testid="inventory-lookup"
                  inputmode="numeric"
                  placeholder="Ej. 101"
                  :disabled="busy || operationPending || alertsPending || countImportPending"
                />
              </label>
              <button
                type="submit"
                class="adm-btn adm-btn--secondary"
                :disabled="busy || operationPending || alertsPending || countImportPending || !authorize()"
              >
                Ver existencias
              </button>
            </form>
          </details>
        </div>

        <div v-show="tab === 'alertas'">
          <InventoryAlertsPanel
            :scope-key="scopeKey"
            :enabled="authorize()"
            :pending="busy || operationPending || countImportPending"
            :selected-variant-id="data?.variant.id"
            @pending="alertsPending = $event"
            @select-variant="openVariantFromAlert"
          />
        </div>

        <div v-show="tab === 'recuentos'">
          <InventoryCountImportPanel
            :scope-key="scopeKey"
            :enabled="authorize()"
            :pending="busy || operationPending || alertsPending"
            @pending="countImportPending = $event"
            @confirmed="refreshAfterCountImport"
          />
        </div>

        <div v-show="tab === 'lotes'">
          <InventoryLotsCostingForecastPanel
            v-if="data"
            :scope-key="scopeKey"
            :enabled="authorize()"
            :pending="busy || operationPending || alertsPending || countImportPending"
            :selected-variant-uuid="data.variant.uuid"
            :selected-variant-id="data.variant.id"
          />
          <AdminCard v-else>
            <AdminEmptyState
              icon="i-lucide-package-search"
              title="Elige primero un producto"
              description="Los lotes, los costes y la previsión se muestran producto a producto."
            >
              <AdminButton @click="tab = 'existencias'">Buscar un producto</AdminButton>
            </AdminEmptyState>
          </AdminCard>
        </div>

        <div v-show="tab === 'reservas'">
          <InventoryOperationsPanel
            v-if="data"
            :scope-key="scopeKey"
            :enabled="authorize()"
            :pending="busy || operationPending || alertsPending || countImportPending"
            :selected-variant-uuid="data.variant.uuid"
          />
          <AdminCard v-else>
            <AdminEmptyState
              icon="i-lucide-package-search"
              title="Elige primero un producto"
              description="Las reservas para contratos, las ubicaciones y las compras se muestran producto a producto."
            >
              <AdminButton @click="tab = 'existencias'">Buscar un producto</AdminButton>
            </AdminEmptyState>
          </AdminCard>
        </div>

        <AdminDrawer
          v-model:open="detailOpen"
          wide
          :title="data ? `${data.variant.sku} · ${data.variant.format}` : 'Existencias del producto'"
          description="Consulta el stock, registra una entrada o propón un recuento."
        >
          <div class="adm-stack">
            <div v-if="data" class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <AdminBadge :tone="stockState(data.balance).tone">{{ stockState(data.balance).label }}</AdminBadge>
              <span class="adm-help">
                Disponible: {{ data.balance.sellableQuantity }} · Reservado: {{ data.balance.reservedQuantity }} ·
                Mínimo: {{ data.balance.safetyStock }}
              </span>
            </div>
            <InventoryOperations
              v-if="contextIdentity"
              :key="`${scopeKey}:${contextIdentity.variantUuid}`"
              :scope-key="scopeKey"
              :snapshot="data"
              :operator-id="operatorId"
              :runtime="runtime"
              :authorize="authorizeInventoryOperation"
              :reload="reload"
              @pending="operationPending = $event"
            />
            <nav
              v-if="data"
              aria-label="Páginas de movimientos"
              class="flex flex-wrap items-center justify-between gap-3"
            >
              <AdminButton
                size="sm"
                icon="i-lucide-chevron-left"
                :disabled="busy || operationPending || alertsPending || countImportPending || page <= 1"
                @click="movePage(-1)"
              >
                Anterior
              </AdminButton>
              <span class="adm-help">{{ data.ledger.pagination.total }} movimientos registrados</span>
              <AdminButton
                size="sm"
                :disabled="
                  busy ||
                  operationPending ||
                  alertsPending ||
                  countImportPending ||
                  page >= data.ledger.pagination.pages
                "
                @click="movePage(1)"
              >
                Siguiente
              </AdminButton>
            </nav>
          </div>
          <template #footer>
            <AdminButton :disabled="operationPending" @click="detailOpen = false">Cerrar</AdminButton>
          </template>
        </AdminDrawer>
      </template>
    </div>
  </AdminPage>
</template>
