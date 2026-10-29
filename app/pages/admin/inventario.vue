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
definePageMeta({ layout: 'default', middleware: 'auth' })
useSeoMeta({ title: 'Inventario operativo · NETECO', robots: 'noindex, nofollow, noarchive' })
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
    message.value = 'No se pudo confirmar el balance seleccionado después del recuento.'
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
    message.value = 'Indica el ID numérico canónico de la variante, sin ceros iniciales.'
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
      'No se ha podido confirmar el contexto. Comprueba acceso, MFA y conciliación; no se muestran saldos cero de sustitución.'
  } finally {
    if (active && generation === epoch) busy.value = false
  }
}
async function search(delta = 0) {
  if (busy.value || operationPending.value || alertsPending.value || countImportPending.value || !authorize()) return
  const requestedPage = delta ? searchPage.value + delta : 1,
    query = inventoryVariantSearchInputSchema.safeParse({ q: searchText.value, page: requestedPage, perPage: 25 })
  if (!query.success) {
    message.value = 'Busca un SKU o nombre con 2–100 caracteres, sin caracteres de control.'
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
    message.value = 'No se ha podido confirmar la búsqueda privada. No se interpreta como catálogo vacío.'
  } finally {
    if (active && generation === epoch) busy.value = false
  }
}
async function selectVariant(id: number) {
  if (busy.value || operationPending.value || alertsPending.value || countImportPending.value || !authorize()) return
  legacyId.value = String(id)
  await load()
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
    message.value = 'No se ha podido confirmar esta página de movimientos.'
  } finally {
    if (active && generation === epoch) busy.value = false
  }
}
watch(scopeKey, purge, { flush: 'sync' })
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
    void selectVariant(Number(parsed.data))
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
  <div class="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:py-12">
    <header>
      <p class="text-xs font-semibold uppercase tracking-wider text-neteco-700">Operaciones de almacén</p>
      <h1 class="mt-2 text-3xl font-bold tracking-tight text-slate-950">Inventario operativo</h1>
      <p class="mt-3 max-w-3xl text-slate-600">
        Consulta existencias, registra entradas y verifica recuentos del único almacén. Acceso privado para operadores
        con permisos vigentes y MFA; no exige permisos de catálogo.
      </p>
    </header>
    <InventoryAlertsPanel
      v-if="runtime === 'cloudflare'"
      :scope-key="scopeKey"
      :enabled="authorize()"
      :pending="busy || operationPending || countImportPending"
      :selected-variant-id="data?.variant.id"
      @pending="alertsPending = $event"
      @select-variant="selectVariant"
    />
    <InventoryCountImportPanel
      v-if="runtime === 'cloudflare'"
      :scope-key="scopeKey"
      :enabled="authorize()"
      :pending="busy || operationPending || alertsPending"
      @pending="countImportPending = $event"
      @confirmed="refreshAfterCountImport"
    />
    <p v-if="runtime !== 'cloudflare'" role="status" class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
      Este flujo gobernado está disponible únicamente en el adaptador Cloudflare.
    </p>
    <section
      v-else
      class="space-y-4 rounded-2xl border border-slate-200 bg-white p-5"
      aria-label="Seleccionar variante por SKU o nombre"
    >
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="search()">
        <label class="block flex-1 text-sm font-medium"
          >SKU o nombre de producto<input
            v-model="searchText"
            data-testid="inventory-search"
            maxlength="100"
            placeholder="Ej. desengrasante o SKU-101"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            :disabled="busy || operationPending || alertsPending || countImportPending"
        /></label>
        <UButton
          type="submit"
          data-testid="search-inventory"
          :loading="busy"
          :disabled="operationPending || alertsPending || countImportPending || !authorize()"
          >Buscar variante</UButton
        >
      </form>
      <div v-if="searchResults" class="space-y-3">
        <p v-if="!searchResults.items.length" class="text-sm text-slate-600">
          No hay coincidencias en esta consulta confirmada.
        </p>
        <ul class="divide-y divide-slate-200">
          <li
            v-for="item in searchResults.items"
            :key="item.uuid"
            class="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div>
              <p class="font-medium">{{ item.name }}</p>
              <p class="mt-1 text-sm text-slate-600">
                {{ item.sku }} · unidad base {{ item.unitLabel }} ({{ item.unitBase }})
              </p>
            </div>
            <UButton
              variant="outline"
              data-testid="choose-inventory-variant"
              :disabled="busy || operationPending || alertsPending || countImportPending || !authorize()"
              @click="selectVariant(item.id)"
              >Ver existencias</UButton
            >
          </li>
        </ul>
        <nav aria-label="Páginas de variantes" class="flex items-center justify-between gap-3">
          <UButton
            variant="outline"
            color="neutral"
            :disabled="busy || operationPending || alertsPending || countImportPending || searchPage <= 1"
            @click="search(-1)"
            >Anterior</UButton
          >
          <span class="text-sm text-slate-600"
            >{{ searchResults.pagination.total }} coincidencias · página {{ searchPage }}</span
          >
          <UButton
            variant="outline"
            color="neutral"
            :disabled="
              busy ||
              operationPending ||
              alertsPending ||
              countImportPending ||
              searchPage >= searchResults.pagination.pages
            "
            @click="search(1)"
            >Siguiente</UButton
          >
        </nav>
      </div>
    </section>
    <details v-if="runtime === 'cloudflare'" class="rounded-2xl border border-slate-200 bg-white p-5">
      <summary class="cursor-pointer text-sm font-medium">Atajo: consultar por ID de variante</summary>
      <form
        class="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-5"
        @submit.prevent="load"
      >
        <label class="block flex-1 text-sm font-medium"
          >ID de variante<input
            v-model="legacyId"
            data-testid="inventory-lookup"
            inputmode="numeric"
            placeholder="Ej. 101"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            :disabled="busy || operationPending || alertsPending || countImportPending"
        /></label>
        <UButton
          type="submit"
          :loading="busy"
          :disabled="operationPending || alertsPending || countImportPending || !authorize()"
          >Consultar existencias</UButton
        >
      </form>
    </details>
    <p v-if="message" role="status" class="rounded-xl border border-slate-200 p-4 text-sm">{{ message }}</p>
    <InventoryOperations
      v-if="contextIdentity && runtime === 'cloudflare'"
      :key="`${scopeKey}:${contextIdentity.variantUuid}`"
      :scope-key="scopeKey"
      :snapshot="data"
      :operator-id="operatorId"
      :runtime="runtime"
      :authorize="authorizeInventoryOperation"
      :reload="reload"
      @pending="operationPending = $event"
    />
    <nav v-if="data" aria-label="Páginas de movimientos" class="flex items-center justify-between gap-3">
      <UButton
        variant="outline"
        color="neutral"
        :disabled="busy || operationPending || alertsPending || countImportPending || page <= 1"
        @click="movePage(-1)"
        >Anterior</UButton
      ><span class="text-sm text-slate-600">{{ data.ledger.pagination.total }} movimientos confirmados</span
      ><UButton
        variant="outline"
        color="neutral"
        :disabled="
          busy || operationPending || alertsPending || countImportPending || page >= data.ledger.pagination.pages
        "
        @click="movePage(1)"
        >Siguiente</UButton
      >
    </nav>
  </div>
</template>
