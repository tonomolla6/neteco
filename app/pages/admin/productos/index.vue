<script setup lang="ts">
import type { AdminProductSummary } from '~~/shared/types/admin'
import type { CategoryResponse } from '~~/shared/types/catalog'
import { catalogActionAvailable, type CatalogCapabilitiesMetadata } from '~/utils/catalogCapabilities'
import CatalogEditorialImport from '~/components/CatalogEditorialImport.vue'
import CatalogSnapshotExport from '~/components/CatalogSnapshotExport.vue'
import CatalogFilePreflight from '~/components/CatalogFilePreflight.vue'
import CatalogNativeImport from '~/components/CatalogNativeImport.vue'
import CatalogImportJob from '~/components/CatalogImportJob.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Productos · Admin' })

/**
 * Listado de productos.
 *
 * Antes tenía un `<select>` de estado suelto en cada fila que aplicaba el cambio **sin
 * confirmación y sin pedir motivo** —lo autogeneraba—, de modo que un clic o una rueda de
 * ratón despublicaba un producto de la tienda. Y la tabla desbordaba 25 px en móvil.
 *
 * Ahora el estado se lee y se cambia desde una acción explícita, con confirmación y motivo
 * auditable, y hay acciones masivas para trabajar sobre varias referencias a la vez.
 */
/**
 * `TODOS` en vez de cadena vacía: `USelect` reserva `''` para «sin selección», y una
 * opción con ese valor rompe el render en servidor — el listado entero devolvía la
 * página de error. Al construir la consulta se traduce a «sin filtro».
 */
const TODOS = 'todos'
const q = ref('')
const category = ref(TODOS)
const estado = ref(TODOS)
const page = ref(1)
const perPage = 25
const selected = ref<string[]>([])
const serverRuntime = useRuntimeConfig().public.serverRuntime
const cloudflare = serverRuntime === 'cloudflare'
const { ready: sessionReady, loggedIn, user } = useUserSession()

const { data: catData } = await useFetch<CategoryResponse>(cloudflare ? '/api/admin/categories' : '/api/categories', {
  key: cloudflare ? 'admin-categories' : 'categories'
})
const catOptions = computed(() => [
  { label: 'Todas las familias', value: TODOS },
  ...flattenCategoryTree(catData.value?.roots ?? []).map((c) => ({ label: c.label, value: String(c.id) }))
])

const STATUS_LABELS: Record<AdminProductSummary['status'], string> = {
  draft: 'Borrador',
  review: 'En revisión',
  published: 'Publicado',
  hidden: 'Oculto',
  discontinued: 'Descatalogado'
}
const STATUS_TONE: Record<AdminProductSummary['status'], 'success' | 'warning' | 'neutral' | 'danger'> = {
  draft: 'neutral',
  review: 'warning',
  published: 'success',
  hidden: 'neutral',
  discontinued: 'danger'
}
const STATUS_TRANSITIONS: Record<AdminProductSummary['status'], AdminProductSummary['status'][]> = {
  draft: ['review', 'hidden', 'discontinued'],
  review: ['draft', 'published', 'hidden'],
  published: ['hidden', 'discontinued'],
  hidden: ['draft', 'review', 'published', 'discontinued'],
  discontinued: ['draft']
}
const statusOptions = [
  { label: 'Todos los estados', value: TODOS },
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ label, value }))
]

const filters = computed(() => ({
  ...(q.value.trim() ? { q: q.value.trim() } : {}),
  ...(category.value !== TODOS ? { category: category.value } : {}),
  ...(estado.value !== TODOS ? { status: estado.value } : {})
}))
const {
  data,
  refresh,
  status: fetchStatus
} = await useFetch<{ items: AdminProductSummary[]; source?: unknown } & CatalogCapabilitiesMetadata>(
  '/api/admin/products',
  {
    query: filters
  }
)
const canCreate = computed(() => {
  if (serverRuntime !== 'cloudflare' && serverRuntime !== 'node') return false
  if (!cloudflare) return catalogActionAvailable(data.value, 'productCreate', false)
  if (
    sessionReady.value !== true ||
    loggedIn.value !== true ||
    user.value?.role !== 'admin' ||
    user.value.mfaVerified !== true
  )
    return false
  const record = data.value
  if (
    fetchStatus.value !== 'success' ||
    !record ||
    Object.getOwnPropertyDescriptor(record, 'source')?.value !== 'cloudflare' ||
    !Array.isArray(Object.getOwnPropertyDescriptor(record, 'items')?.value)
  )
    return false
  const capabilities = Object.getOwnPropertyDescriptor(record, 'capabilities')?.value as unknown
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false
  return (
    Object.getOwnPropertyDescriptor(capabilities, 'productsRead')?.value === true &&
    Object.getOwnPropertyDescriptor(capabilities, 'productDraftCreate')?.value === true
  )
})
const canChangeStatus = computed(() => catalogActionAvailable(data.value, 'productStatusUpdate', cloudflare))
const canEditorialImport = computed(() => {
  if (
    !cloudflare ||
    fetchStatus.value !== 'success' ||
    sessionReady.value !== true ||
    loggedIn.value !== true ||
    user.value?.role !== 'admin' ||
    user.value.mfaVerified !== true
  )
    return false
  const record = data.value
  if (
    !record ||
    Object.getOwnPropertyDescriptor(record, 'source')?.value !== 'cloudflare' ||
    !Array.isArray(Object.getOwnPropertyDescriptor(record, 'items')?.value)
  )
    return false
  const capabilities: unknown = Object.getOwnPropertyDescriptor(record, 'capabilities')?.value
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false
  return ['productsRead', 'productMetadataUpdate', 'productEditorialImport'].every(
    (key) => Object.getOwnPropertyDescriptor(capabilities, key)?.value === true
  )
})
const canNativeImport = computed(() => {
  if (!canEditorialImport.value) return false
  const capabilities: unknown = Object.getOwnPropertyDescriptor(data.value!, 'capabilities')?.value
  return (
    !!capabilities &&
    typeof capabilities === 'object' &&
    !Array.isArray(capabilities) &&
    Object.getOwnPropertyDescriptor(capabilities, 'productNativeImport')?.value === true
  )
})
const canDelete = computed(() => catalogActionAvailable(data.value, 'productDelete', cloudflare))
const canImportJobPreparation = computed(() => {
  if (!canNativeImport.value) return false
  const capabilities: unknown = Object.getOwnPropertyDescriptor(data.value!, 'capabilities')?.value
  return (
    !!capabilities &&
    typeof capabilities === 'object' &&
    !Array.isArray(capabilities) &&
    Object.getOwnPropertyDescriptor(capabilities, 'productImportJobPreparation')?.value === true
  )
})
const canImportJobCommands = computed(() => {
  if (!canNativeImport.value) return false
  const capabilities: unknown = Object.getOwnPropertyDescriptor(data.value!, 'capabilities')?.value
  return (
    !!capabilities &&
    typeof capabilities === 'object' &&
    !Array.isArray(capabilities) &&
    Object.getOwnPropertyDescriptor(capabilities, 'productImportJobCommands')?.value === true
  )
})
const canSnapshotExport = computed(() => {
  if (
    !cloudflare ||
    fetchStatus.value !== 'success' ||
    sessionReady.value !== true ||
    loggedIn.value !== true ||
    user.value?.role !== 'admin' ||
    user.value.mfaVerified !== true
  )
    return false
  const record = data.value
  if (
    !record ||
    Object.getOwnPropertyDescriptor(record, 'source')?.value !== 'cloudflare' ||
    !Array.isArray(Object.getOwnPropertyDescriptor(record, 'items')?.value)
  )
    return false
  const capabilities: unknown = Object.getOwnPropertyDescriptor(record, 'capabilities')?.value
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false
  return ['productsRead', 'productSnapshotExport'].every(
    (key) => Object.getOwnPropertyDescriptor(capabilities, key)?.value === true
  )
})
const snapshotFilters = computed(() => ({
  ...(q.value.trim() ? { q: q.value.trim() } : {}),
  ...(category.value !== TODOS ? { category: Number(category.value) } : {}),
  ...(estado.value !== TODOS ? { status: estado.value } : {})
}))

const items = computed(() => data.value?.items ?? [])
const filtered = computed(() => Boolean(q.value.trim()) || category.value !== TODOS || estado.value !== TODOS)
function clearFilters() {
  q.value = ''
  category.value = TODOS
  estado.value = TODOS
}
watch([q, category, estado], () => {
  page.value = 1
  selected.value = []
})

const toast = useToast()
const saving = ref(false)

const columns = [
  { key: 'name', label: 'Producto', sortable: true },
  { key: 'categoryName', label: 'Familia', sortable: true, hideOnMobile: true },
  { key: 'formats', label: 'Variantes', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'minPrice', label: 'Precio desde', numeric: true, sortable: true },
  { key: 'status', label: 'Estado' }
]

/* --- Apartados de la pantalla: el listado es lo principal; importar y exportar, aparte --- */
const view = ref('productos')
const viewTabs = [
  { value: 'productos', label: 'Productos' },
  { value: 'importar', label: 'Importar' },
  { value: 'exportar', label: 'Exportar' }
]
const importMode = ref('textos')
const importModes = computed(() => [
  { value: 'textos', label: 'Actualizar textos' },
  ...(canEditorialImport.value ? [{ value: 'comprobar', label: 'Comprobar un archivo' }] : []),
  ...(canNativeImport.value ? [{ value: 'alta', label: 'Dar de alta productos' }] : []),
  ...(canImportJobPreparation.value ? [{ value: 'grande', label: 'Catálogo grande por partes' }] : [])
])
watch(importModes, (modes) => {
  if (!modes.some((mode) => mode.value === importMode.value)) importMode.value = 'textos'
})

/* --- Cambio de estado --- */
const changing = ref<{ products: AdminProductSummary[]; to: AdminProductSummary['status'] } | null>(null)
const reason = ref('')

function startChange(products: AdminProductSummary[], to: AdminProductSummary['status']) {
  if (!canChangeStatus.value) return
  changing.value = { products, to }
  reason.value = ''
}

async function confirmChange() {
  if (!canChangeStatus.value) return
  const target = changing.value
  if (!target) return
  saving.value = true
  const failed: string[] = []
  for (const product of target.products) {
    try {
      await $fetch(`/api/admin/products/${product.id}/active`, {
        method: 'PUT',
        body: {
          status: target.to,
          reason: reason.value.trim() || `Transición editorial ${product.status} → ${target.to}`
        }
      })
    } catch {
      failed.push(product.name)
    }
  }
  saving.value = false
  await refresh()
  await refreshNuxtData('categories')
  selected.value = []
  changing.value = null
  if (failed.length) {
    toast.add({ title: `No se han podido cambiar: ${failed.join(', ')}`, color: 'error' })
  } else {
    const count = target.products.length
    toast.add({
      title: `${count} ${count === 1 ? 'producto' : 'productos'} a «${STATUS_LABELS[target.to]}»`,
      color: 'success',
      icon: target.to === 'published' ? 'i-lucide-eye' : 'i-lucide-workflow'
    })
  }
}

/* --- Borrado --- */
const removing = ref<AdminProductSummary | null>(null)

async function confirmRemove() {
  if (!canDelete.value) return
  const product = removing.value
  if (!product) return
  saving.value = true
  try {
    await $fetch(`/api/admin/products/${product.id}`, { method: 'DELETE' })
    toast.add({ title: 'Producto eliminado', icon: 'i-lucide-trash-2', color: 'success' })
    removing.value = null
    await refresh()
    await refreshNuxtData('categories')
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido eliminar'), color: 'error' })
  } finally {
    saving.value = false
  }
}

const selectedProducts = computed(() => items.value.filter((item) => selected.value.includes(String(item.id))))
/** Estados a los que se puede llevar TODA la selección: si no coinciden, no se ofrece. */
const bulkTargets = computed(() => {
  if (!selectedProducts.value.length) return []
  return Object.keys(STATUS_LABELS).filter((candidate) =>
    selectedProducts.value.every(
      (product) =>
        product.status !== candidate &&
        STATUS_TRANSITIONS[product.status].includes(candidate as AdminProductSummary['status'])
    )
  ) as AdminProductSummary['status'][]
})
</script>

<template>
  <AdminPage :count="items.length" :count-label="items.length === 1 ? 'producto' : 'productos'">
    <template #actions>
      <AdminButton v-if="canCreate" variant="primary" to="/admin/productos/nuevo" icon="i-lucide-plus">
        Nuevo producto
      </AdminButton>
    </template>
    <div class="adm-stack">
      <AdminTabs v-model="view" :tabs="viewTabs" label="Apartados de productos" />

      <div v-show="view === 'productos'" class="adm-stack">
        <UAlert
          v-if="cloudflare && !canChangeStatus"
          role="status"
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          description="Las ediciones de contenido afectan sólo a borradores. Precios, stock y publicación tienen controles separados."
        />

        <AdminTable
          v-model:selected="selected"
          v-model:page="page"
          :rows="items"
          :columns="columns"
          :row-key="(row) => String(row.id)"
          :row-to="(row) => `/admin/productos/${row.id}`"
          :status="fetchStatus"
          :per-page="perPage"
          :selectable="canChangeStatus"
          :filtered="filtered"
          empty-icon="i-lucide-package"
          empty-title="Todavía no hay productos"
          empty-description="Crea el primero o tráelos desde un archivo en el apartado «Importar»."
          error-message="No hemos podido cargar los productos. Vuelve a intentarlo."
          caption="Productos del catálogo"
          @retry="refresh()"
          @clear-filters="clearFilters"
        >
          <template #toolbar>
            <AdminToolbar
              v-model:search="q"
              placeholder="Buscar por nombre, marca o referencia"
              search-label="Buscar productos"
            >
              <USelect v-model="category" :items="catOptions" class="w-48" aria-label="Filtrar por familia" />
              <USelect v-model="estado" :items="statusOptions" class="w-44" aria-label="Filtrar por estado" />
            </AdminToolbar>
          </template>

          <template #bulk>
            <span class="text-[var(--text-muted)]">Cambiar a:</span>
            <AdminButton
              v-for="target in bulkTargets"
              :key="target"
              size="sm"
              @click="startChange(selectedProducts, target)"
            >
              {{ STATUS_LABELS[target] }}
            </AdminButton>
            <span v-if="!bulkTargets.length" class="adm-help">
              Los productos elegidos están en estados distintos y no admiten un mismo cambio.
            </span>
          </template>

          <template #empty-action>
            <AdminButton v-if="canCreate" variant="primary" to="/admin/productos/nuevo" icon="i-lucide-plus">
              Nuevo producto
            </AdminButton>
          </template>

          <template #cell-name="{ row }">
            <div class="flex min-w-0 items-center gap-3">
              <div class="w-9 shrink-0"><ProductVisual :visual="row.visual" /></div>
              <div class="min-w-0">
                <NuxtLink
                  :to="`/admin/productos/${row.id}`"
                  class="block truncate font-medium text-[var(--text-strong)] hover:text-neteco-700 hover:underline"
                >
                  {{ row.name }}
                </NuxtLink>
                <p class="truncate text-xs text-[var(--text-muted)]">
                  {{ row.brand }}<template v-if="row.series"> · gama {{ row.series }}</template>
                  <template v-if="row.featured"> · destacado</template>
                </p>
              </div>
            </div>
          </template>

          <template #cell-categoryName="{ row }">
            <span class="text-[var(--text-muted)]">{{ row.categoryName }}</span>
          </template>

          <template #cell-minPrice="{ row }">
            <span v-if="row.minPrice == null" class="text-[var(--text-muted)]">Sin variantes</span>
            <span v-else class="font-semibold tabular-nums">{{ formatPrice(row.minPrice) }}</span>
          </template>

          <template #cell-status="{ row }">
            <AdminBadge :tone="STATUS_TONE[row.status]">{{ STATUS_LABELS[row.status] }}</AdminBadge>
          </template>

          <template #actions="{ row }">
            <div class="flex items-center justify-end gap-1">
              <UDropdownMenu
                v-if="canChangeStatus"
                :items="[
                  STATUS_TRANSITIONS[row.status].map((target) => ({
                    label: STATUS_LABELS[target],
                    onSelect: () => startChange([row], target)
                  }))
                ]"
              >
                <button type="button" class="adm-btn adm-btn--secondary adm-btn--sm">
                  Estado
                  <UIcon name="i-lucide-chevron-down" class="size-4" />
                </button>
              </UDropdownMenu>
              <AdminButton
                v-if="row.active"
                :to="`/producto/${row.slug}`"
                target="_blank"
                external
                variant="ghost"
                size="sm"
                icon="i-lucide-external-link"
                :label="`Ver ${row.name} en la tienda`"
              />
              <AdminButton
                :to="`/admin/productos/${row.id}`"
                variant="ghost"
                size="sm"
                icon="i-lucide-pencil"
                :label="`${cloudflare ? 'Consultar' : 'Editar'} ${row.name}`"
              />
              <AdminButton
                v-if="canDelete"
                variant="ghost"
                size="sm"
                icon="i-lucide-trash-2"
                :label="`Eliminar ${row.name}`"
                @click="removing = row"
              />
            </div>
          </template>
        </AdminTable>
      </div>

      <!-- v-show y no v-if: una importación a medias no debe perderse al cambiar de apartado. -->
      <div v-show="view === 'importar'" class="adm-stack">
        <AdminToolbar v-if="importModes.length > 1" :searchable="false">
          <AdminFilters v-model="importMode" :options="importModes" label="Qué quieres importar" />
        </AdminToolbar>
        <div v-show="importMode === 'textos'">
          <CatalogEditorialImport :runtime="serverRuntime" :available="canEditorialImport" />
        </div>
        <div v-show="importMode === 'comprobar'">
          <CatalogFilePreflight :runtime="serverRuntime" :available="canEditorialImport" />
        </div>
        <div v-show="importMode === 'alta'">
          <CatalogNativeImport :runtime="serverRuntime" :available="canNativeImport" />
        </div>
        <div v-show="importMode === 'grande'">
          <CatalogImportJob
            :runtime="serverRuntime"
            :available="canImportJobPreparation"
            :commands-available="canImportJobCommands"
          />
        </div>
      </div>

      <div v-show="view === 'exportar'" class="adm-stack">
        <CatalogSnapshotExport :runtime="serverRuntime" :available="canSnapshotExport" :filters="snapshotFilters" />
      </div>

      <AdminConfirm
        :open="Boolean(changing)"
        title="Cambiar el estado"
        confirm-label="Cambiar estado"
        :loading="saving"
        @update:open="(value) => !value && (changing = null)"
        @confirm="confirmChange"
      >
        <div v-if="changing" class="adm-stack">
          <p class="text-[var(--text)]">
            <template v-if="changing.products.length === 1">
              <strong>{{ changing.products[0]!.name }}</strong> pasará a
            </template>
            <template v-else>
              <strong>{{ changing.products.length }} productos</strong> pasarán a
            </template>
            <AdminBadge class="ml-1" :tone="STATUS_TONE[changing.to]">{{ STATUS_LABELS[changing.to] }}</AdminBadge>
          </p>

          <p v-if="changing.to === 'published'" class="adm-help">Quedarán visibles en la tienda y en los buscadores.</p>
          <UAlert
            v-else-if="changing.to === 'hidden' || changing.to === 'discontinued'"
            color="warning"
            variant="subtle"
            description="Dejarán de verse en la tienda. Los pedidos ya hechos no se ven afectados."
          />

          <ul
            v-if="changing.products.length > 1"
            class="max-h-40 space-y-1 overflow-y-auto rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3 text-sm"
          >
            <li v-for="product in changing.products" :key="product.id" class="truncate">{{ product.name }}</li>
          </ul>

          <UFormField label="Motivo" hint="Opcional: queda anotado en el historial del producto">
            <UInput v-model="reason" class="w-full" placeholder="Campaña, fin de gama, error de ficha…" />
          </UFormField>
        </div>
      </AdminConfirm>

      <AdminConfirm
        :open="Boolean(removing)"
        title="Eliminar producto"
        confirm-label="Eliminar definitivamente"
        danger
        :loading="saving"
        @update:open="(value) => !value && (removing = null)"
        @confirm="confirmRemove"
      >
        <p class="text-[var(--text)]">
          Se eliminará <strong>{{ removing?.name }}</strong> y sus {{ removing?.formats }}
          {{ removing?.formats === 1 ? 'variante' : 'variantes' }}.
          <strong>Esta acción no se puede deshacer.</strong>
        </p>
        <p class="adm-help mt-3">
          Si solo quieres quitarlo de la tienda, cámbialo a «Descatalogado» en lugar de eliminarlo: así conserva su
          historial y sus referencias.
        </p>
      </AdminConfirm>
    </div>
  </AdminPage>
</template>
