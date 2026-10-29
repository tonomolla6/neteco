<script setup lang="ts">
import type { AdminProductSummary } from '~~/shared/types/admin'
import type { CategoryResponse } from '~~/shared/types/catalog'
import type { Column } from '~/components/ui/DataTable.vue'
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
const STATUS_COLOR: Record<AdminProductSummary['status'], 'success' | 'warning' | 'neutral' | 'error'> = {
  draft: 'neutral',
  review: 'warning',
  published: 'success',
  hidden: 'neutral',
  discontinued: 'error'
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
const paged = computed(() => items.value.slice((page.value - 1) * perPage, page.value * perPage))
watch([q, category, estado], () => {
  page.value = 1
  selected.value = []
})

const toast = useToast()
const saving = ref(false)

const columns: Column<AdminProductSummary>[] = [
  { key: 'name', label: 'Producto' },
  { key: 'categoryName', label: 'Familia', hideOnMobile: true },
  { key: 'formats', label: 'Variantes', numeric: true, hideOnMobile: true },
  { key: 'minPrice', label: 'Desde', numeric: true },
  { key: 'status', label: 'Estado' }
]

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
  <div>
    <UiPageHeader
      title="Productos"
      :count="items.length"
      :count-label="items.length === 1 ? 'producto' : 'productos'"
      description="Catálogo, estado editorial y precio de entrada de cada producto."
    >
      <template #actions>
        <UButton v-if="canCreate" to="/admin/productos/nuevo" icon="i-lucide-plus">Nuevo producto</UButton>
      </template>
    </UiPageHeader>
    <p v-if="cloudflare && !canChangeStatus" role="status" class="mb-4 text-sm text-[var(--text-muted)]">
      Las ediciones de contenido afectan sólo a borradores. Precios, stock y publicación tienen controles separados.
    </p>

    <CatalogEditorialImport :runtime="serverRuntime" :available="canEditorialImport" />
    <CatalogFilePreflight :runtime="serverRuntime" :available="canEditorialImport" />
    <CatalogNativeImport :runtime="serverRuntime" :available="canNativeImport" />
    <CatalogImportJob
      :runtime="serverRuntime"
      :available="canImportJobPreparation"
      :commands-available="canImportJobCommands"
    />
    <CatalogSnapshotExport :runtime="serverRuntime" :available="canSnapshotExport" :filters="snapshotFilters" />

    <UiDataTable
      v-model:selected="selected"
      :rows="paged"
      :columns="columns"
      :row-key="(row) => String(row.id)"
      :status="fetchStatus === 'pending' ? 'pending' : fetchStatus === 'error' ? 'error' : 'idle'"
      :total="items.length"
      :page="page"
      :per-page="perPage"
      :selectable="canChangeStatus"
      search-placeholder="Buscar por nombre, marca o referencia"
      empty-title="Todavía no hay productos"
      empty-description="Crea el primero o impórtalos con el contrato tabular del catálogo."
      error-message="No hemos podido cargar el catálogo."
      @search="(value) => (q = value)"
      @update:page="(value) => (page = value)"
      @retry="refresh()"
    >
      <template #filters>
        <USelect v-model="category" :items="catOptions" class="w-56" aria-label="Filtrar por familia" />
        <USelect v-model="estado" :items="statusOptions" class="w-44" aria-label="Filtrar por estado" />
      </template>

      <template #bulk-actions>
        <UButton
          v-for="target in bulkTargets"
          :key="target"
          size="xs"
          color="neutral"
          variant="outline"
          @click="startChange(selectedProducts, target)"
        >
          {{ STATUS_LABELS[target] }}
        </UButton>
        <span v-if="!bulkTargets.length" class="text-xs text-[var(--text-muted)]">
          Los productos seleccionados están en estados distintos: no hay una transición común.
        </span>
      </template>

      <template #empty-action>
        <UButton v-if="canCreate" to="/admin/productos/nuevo" icon="i-lucide-plus">Nuevo producto</UButton>
      </template>

      <template #cell-name="{ row }">
        <div class="flex items-center gap-3">
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
        <span class="font-semibold">{{ row.minPrice == null ? 'Sin variantes' : formatPrice(row.minPrice) }}</span>
      </template>

      <template #cell-status="{ row }">
        <UBadge :color="STATUS_COLOR[row.status]" variant="subtle">{{ STATUS_LABELS[row.status] }}</UBadge>
      </template>

      <template #row-actions="{ row }">
        <div class="flex justify-end gap-0.5">
          <UDropdownMenu
            v-if="canChangeStatus"
            :items="[
              STATUS_TRANSITIONS[row.status].map((target) => ({
                label: STATUS_LABELS[target],
                onSelect: () => startChange([row], target)
              }))
            ]"
          >
            <UButton size="xs" color="neutral" variant="outline" trailing-icon="i-lucide-chevron-down">
              Estado
            </UButton>
          </UDropdownMenu>
          <UButton
            v-if="row.active"
            :to="`/producto/${row.slug}`"
            target="_blank"
            external
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-external-link"
            :aria-label="`Ver ${row.name} en la tienda`"
          />
          <UButton
            :to="`/admin/productos/${row.id}`"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-pencil"
            :aria-label="`${cloudflare ? 'Consultar' : 'Editar'} ${row.name}`"
          />
          <UButton
            v-if="canDelete"
            size="xs"
            color="error"
            variant="ghost"
            icon="i-lucide-trash-2"
            :aria-label="`Eliminar ${row.name}`"
            @click="removing = row"
          />
        </div>
      </template>
    </UiDataTable>

    <UModal
      :open="Boolean(changing)"
      title="Cambiar el estado editorial"
      @update:open="(value) => !value && (changing = null)"
    >
      <template #body>
        <div v-if="changing" class="space-y-4">
          <p class="text-[var(--text)]">
            <template v-if="changing.products.length === 1">
              <strong>{{ changing.products[0]!.name }}</strong> pasará a
            </template>
            <template v-else>
              <strong>{{ changing.products.length }} productos</strong> pasarán a
            </template>
            <UBadge class="ml-1" :color="STATUS_COLOR[changing.to]" variant="subtle">
              {{ STATUS_LABELS[changing.to] }}
            </UBadge>
          </p>

          <p v-if="changing.to === 'published'" class="text-sm text-[var(--text-muted)]">
            Quedarán visibles en la tienda y en los buscadores.
          </p>
          <p v-else-if="changing.to === 'hidden' || changing.to === 'discontinued'" class="text-sm text-amber-800">
            Dejarán de verse en la tienda. Los pedidos ya hechos no se ven afectados.
          </p>

          <ul
            v-if="changing.products.length > 1"
            class="max-h-40 space-y-1 overflow-y-auto rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3 text-sm"
          >
            <li v-for="product in changing.products" :key="product.id" class="truncate">{{ product.name }}</li>
          </ul>

          <UFormField label="Motivo" hint="Si lo dejas vacío se registra la transición sin más detalle">
            <UInput v-model="reason" class="w-full" placeholder="Campaña, fin de gama, error de ficha…" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="changing = null">Cancelar</UButton>
          <UButton :loading="saving" @click="confirmChange">Cambiar estado</UButton>
        </div>
      </template>
    </UModal>

    <UModal :open="Boolean(removing)" title="Eliminar producto" @update:open="(value) => !value && (removing = null)">
      <template #body>
        <p class="text-[var(--text)]">
          Se eliminará <strong>{{ removing?.name }}</strong> y sus {{ removing?.formats }}
          {{ removing?.formats === 1 ? 'variante' : 'variantes' }}.
          <strong>Esta acción no se puede deshacer.</strong>
        </p>
        <p class="mt-3 text-sm text-[var(--text-muted)]">
          Si solo quieres quitarlo de la tienda, cámbialo a «Descatalogado» en lugar de eliminarlo: así conserva su
          histórico y sus referencias.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="removing = null">Cancelar</UButton>
          <UButton color="error" :loading="saving" @click="confirmRemove">Eliminar definitivamente</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
