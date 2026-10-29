<script setup lang="ts">
import type { CategoryResponse } from '~~/shared/types/catalog'
import type { D1AdminCategoryResponse, AdminCatalogStatus } from '~~/workers/catalog/admin-catalog'
import { parseD1CategoryAdminView } from '~~/shared/catalog-category-commands'
import CategoryCrudEditor from '../../components/CategoryCrudEditor.vue'
import CategoryAttributeDefinitionsEditor from '../../components/CategoryAttributeDefinitionsEditor.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Familias · Admin' })

/**
 * Árbol de familias.
 *
 * Antes: las 45 familias en una lista plana de 2.451 px, siempre desplegada, sin buscar,
 * con el `id` interno del ERP a la vista en cada fila y desbordando 42 px en móvil.
 * Renombrar sí era posible, pero el campo llevaba `border-transparent` y parecía texto
 * estático, así que no se encontraba. Mover una familia de sitio no se ofrecía, aunque la
 * API ya lo acepta y valida ciclos.
 *
 * Ahora: árbol plegable, búsqueda que abre las ramas con coincidencias, edición explícita
 * en diálogo (renombrar + mover) y el id interno solo cuando se pide.
 */
const runtime = useRuntimeConfig().public.serverRuntime
const cloudflare = runtime === 'cloudflare'
const node = runtime === 'node'
const supportedRuntime = cloudflare || node
const { ready: sessionReady, loggedIn, user } = useUserSession()
function liveSession() {
  return (
    sessionReady.value === true &&
    loggedIn.value === true &&
    user.value?.role === 'admin' &&
    user.value.mfaVerified === true
  )
}
const {
  data: catData,
  status: fetchStatus,
  refresh
} = await useFetch<CategoryResponse | D1AdminCategoryResponse>(node ? '/api/categories' : '/api/admin/categories', {
  key: node ? 'categories' : 'admin-category-tree',
  immediate: supportedRuntime,
  server: supportedRuntime
})
const toast = useToast()
interface CategoryMetadata {
  source?: unknown
  capabilities?: unknown
  unmappedCategories?: unknown
}
type CategoryCapability = 'categoriesRead' | 'categoryCreate' | 'categoryUpdate' | 'categoryDelete'
const privateView = computed(() => (cloudflare ? parseD1CategoryAdminView(catData.value) : null))
const metadata = computed(() => (cloudflare ? privateView.value : (catData.value as CategoryMetadata | null)))
const hasCapabilityMap = computed(() => metadata.value != null && 'capabilities' in metadata.value)
function hasCapability(key: CategoryCapability) {
  const capabilities = metadata.value?.capabilities
  return (
    capabilities !== null &&
    typeof capabilities === 'object' &&
    !Array.isArray(capabilities) &&
    Object.prototype.hasOwnProperty.call(capabilities, key) &&
    (capabilities as Record<CategoryCapability, unknown>)[key] === true
  )
}
const STATUS_LABELS: Record<AdminCatalogStatus, string> = {
  draft: 'Borrador',
  review: 'En revisión',
  published: 'Publicado',
  hidden: 'Oculto',
  discontinued: 'Descatalogado'
}
const validTree = computed(() => {
  if (cloudflare) return privateView.value !== null
  if (!Array.isArray(catData.value?.roots) || !Array.isArray(catData.value?.flat)) return false
  const seen = new Set<number>()
  const pending = catData.value.roots.map((entry) => ({ entry, parent: null as number | null }))
  while (pending.length) {
    const { entry, parent } = pending.pop()!
    if (
      !entry ||
      !Number.isSafeInteger(entry.id) ||
      entry.id <= 0 ||
      seen.has(entry.id) ||
      typeof entry.name !== 'string' ||
      !entry.name.trim() ||
      (cloudflare && entry.parentId !== parent) ||
      (cloudflare &&
        (!('status' in entry) ||
          typeof entry.status !== 'string' ||
          !Object.prototype.hasOwnProperty.call(STATUS_LABELS, entry.status))) ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 0 ||
      !Array.isArray(entry.children)
    )
      return false
    seen.add(entry.id)
    for (const child of entry.children) pending.push({ entry: child, parent: entry.id })
  }
  return true
})
const canRead = computed(() => {
  if (fetchStatus.value !== 'success' || !validTree.value) return false
  return node
    ? metadata.value?.source === undefined && (!hasCapabilityMap.value || hasCapability('categoriesRead'))
    : cloudflare && liveSession() && metadata.value?.source === 'cloudflare' && hasCapability('categoriesRead')
})
function nodeAction(key: 'categoryCreate' | 'categoryUpdate' | 'categoryDelete') {
  // Only a metadata-free legacy Node response gets the original CRUD fallback.
  return node && canRead.value && (!hasCapabilityMap.value || hasCapability(key))
}
const canCreate = computed(() => nodeAction('categoryCreate'))
const canEdit = computed(() => nodeAction('categoryUpdate'))
const canDelete = computed(() => nodeAction('categoryDelete'))
const roots = computed(() => (canRead.value ? (cloudflare ? privateView.value!.roots : catData.value!.roots) : []))
const unmapped = computed(() => {
  const count = metadata.value?.unmappedCategories
  return cloudflare && canRead.value && typeof count === 'number' && Number.isSafeInteger(count) && count > 0
    ? count
    : 0
})
let reading = false
async function reload() {
  if (!supportedRuntime || reading || fetchStatus.value === 'pending' || (cloudflare && !liveSession())) return
  reading = true
  try {
    await refresh()
  } finally {
    reading = false
  }
}
function privateCategoryAuthority(identity?: { id: number; uuid: string; version: number }) {
  if (!cloudflare || !canRead.value || !liveSession()) return false
  const current = parseD1CategoryAdminView(catData.value)
  if (
    !current ||
    !['categoryCreate', 'categoryUpdate', 'categoryDelete'].some((key) => current.capabilities[key] === true)
  )
    return false
  if (!identity) return true
  const category = current.flat.find((row) => row.id === identity.id)?.authoring
  return !!category && category.uuid === identity.uuid && category.version === identity.version
}

interface Row {
  id: number
  name: string
  count: number
  depth: number
  parentId: number | null
  hasChildren: boolean
  status?: AdminCatalogStatus
}

const flat = computed<Row[]>(() => {
  const out: Row[] = []
  const pending = roots.value
    .slice()
    .reverse()
    .map((entry) => ({ entry, depth: 0, parentId: null as number | null }))
  while (pending.length) {
    const { entry: entry, depth, parentId } = pending.pop()!
    out.push({
      id: entry.id,
      name: entry.name,
      count: entry.count,
      depth,
      parentId: cloudflare ? entry.parentId : parentId,
      hasChildren: !!entry.children.length,
      status: cloudflare && 'status' in entry ? (entry.status as AdminCatalogStatus) : undefined
    })
    for (const child of entry.children.slice().reverse())
      pending.push({ entry: child, depth: depth + 1, parentId: entry.id })
  }
  return out
})

// Both endpoints already count the whole subtree. Never sum children twice.

const search = ref('')
const collapsed = ref(new Set<number>())

/** Ancestros de cada familia, para poder abrir las ramas que contienen una coincidencia. */
const ancestors = computed(() => {
  const map = new Map<number, number[]>()
  for (const row of flat.value) {
    const parent = row.parentId
    map.set(row.id, parent === null ? [] : [...(map.get(parent) ?? []), parent])
  }
  return map
})

const matches = computed(() => {
  const term = search.value.trim().toLowerCase()
  if (!term) return null
  const hit = new Set<number>()
  for (const row of flat.value) {
    if (row.name.toLowerCase().includes(term)) {
      hit.add(row.id)
      for (const parent of ancestors.value.get(row.id) ?? []) hit.add(parent)
    }
  }
  return hit
})

const visible = computed(() =>
  flat.value.filter((row) => {
    if (matches.value) return matches.value.has(row.id)
    return !(ancestors.value.get(row.id) ?? []).some((parent) => collapsed.value.has(parent))
  })
)

function toggle(id: number) {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}
function collapseAll() {
  collapsed.value = new Set(flat.value.filter((row) => row.hasChildren).map((row) => row.id))
}
function expandAll() {
  collapsed.value = new Set()
}

const parentOptions = computed(() => [
  { label: '— Familia principal —', value: null as number | null },
  ...flattenCategoryTree(roots.value).map((option) => ({ label: option.label, value: option.id }))
])

/* --- Alta --- */
const creating = ref(false)
const createForm = reactive({ name: '', parentId: null as number | null })
const saving = ref(false)

async function createCategory() {
  if (
    !canCreate.value ||
    saving.value ||
    !createForm.name.trim() ||
    !parentOptions.value.some((option) => option.value === createForm.parentId)
  )
    return
  saving.value = true
  try {
    await $fetch('/api/admin/categories', {
      method: 'POST',
      body: { name: createForm.name.trim(), parentId: createForm.parentId }
    })
    toast.add({ title: 'Familia creada', icon: 'i-lucide-check', color: 'success' })
    createForm.name = ''
    creating.value = false
    await refreshNuxtData('categories')
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido crear'), color: 'error' })
  } finally {
    saving.value = false
  }
}

/* --- Edición: renombrar y mover --- */
const editing = ref<Row | null>(null)
const editForm = reactive({ name: '', parentId: null as number | null })

function startEdit(row: Row) {
  const current = flat.value.find((item) => item.id === row.id)
  if (!canEdit.value || saving.value || !current) return
  editing.value = current
  editForm.name = current.name
  editForm.parentId = current.parentId
}

/** No se puede mover una familia dentro de sí misma ni de sus descendientes. */
const moveOptions = computed(() => {
  const current = editing.value
  if (!current) return parentOptions.value
  const banned = new Set<number>([current.id])
  for (const row of flat.value) {
    if ((ancestors.value.get(row.id) ?? []).some((parent) => banned.has(parent))) banned.add(row.id)
  }
  return parentOptions.value.filter((option) => option.value === null || !banned.has(option.value))
})

async function saveEdit() {
  const row = editing.value
  if (
    !canEdit.value ||
    saving.value ||
    !row ||
    !flat.value.some((current) => current.id === row.id) ||
    !moveOptions.value.some((option) => option.value === editForm.parentId) ||
    !editForm.name.trim()
  )
    return
  saving.value = true
  try {
    await $fetch(`/api/admin/categories/${row.id}`, {
      method: 'PUT',
      body: { name: editForm.name.trim(), parentId: editForm.parentId }
    })
    toast.add({ title: 'Familia actualizada', icon: 'i-lucide-check', color: 'success' })
    editing.value = null
    await refreshNuxtData('categories')
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido guardar'), color: 'error' })
  } finally {
    saving.value = false
  }
}

/* --- Borrado --- */
const removing = ref<Row | null>(null)
function startRemove(row: Row) {
  const current = flat.value.find((item) => item.id === row.id)
  if (!canDelete.value || saving.value || !current || current.hasChildren || current.count > 0) return
  removing.value = current
}

async function confirmRemove() {
  const row = removing.value
  const current = flat.value.find((item) => item.id === row?.id)
  if (!canDelete.value || saving.value || !row || !current || current.hasChildren || current.count > 0) return
  saving.value = true
  try {
    await $fetch(`/api/admin/categories/${row.id}`, { method: 'DELETE' })
    toast.add({ title: 'Familia eliminada', icon: 'i-lucide-trash-2', color: 'success' })
    removing.value = null
    await refreshNuxtData('categories')
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido eliminar'), color: 'error' })
  } finally {
    saving.value = false
  }
}

watch(
  () => (node ? catData.value : null),
  () => {
    creating.value = false
    editing.value = null
    removing.value = null
  },
  { deep: true }
)
watch([canCreate, canEdit, canDelete], ([create, edit, remove]) => {
  if (!create) creating.value = false
  if (!edit) editing.value = null
  if (!remove) removing.value = null
})
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <UiPageHeader
      title="Familias de productos"
      :count="canRead ? flat.length : undefined"
      :count-label="flat.length === 1 ? 'familia' : 'familias'"
      description="El árbol de la tienda: el menú, el catálogo y los filtros se generan de aquí. Los identificadores del ERP se conservan tal cual."
    >
      <template #actions>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          :disabled="!supportedRuntime"
          :loading="fetchStatus === 'pending'"
          @click="reload"
          >Actualizar</UButton
        >
        <UButton v-if="canCreate" icon="i-lucide-plus" @click="canCreate && (creating = true)">Nueva familia</UButton>
      </template>
    </UiPageHeader>

    <UAlert
      v-if="cloudflare"
      class="mb-4"
      color="info"
      title="Familias: gestión editorial privada"
      description="Árbol privado con todos los estados. Los recuentos incluyen subfamilias, no existencias. Las nuevas familias son borradores pendientes de publicación explícita; editar no concede permiso para publicar."
    />
    <UAlert
      v-if="unmapped"
      class="mb-4"
      color="warning"
      title="Familias sin identificador heredado"
      :description="`${unmapped} familias no tienen identificador visible. Sus descendientes mapeados y sus recuentos se conservan en el árbol.`"
    />

    <div v-if="canRead" class="mb-3 flex flex-wrap items-center gap-2">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        placeholder="Buscar familia"
        aria-label="Buscar familia"
        class="w-full sm:w-72"
      >
        <template v-if="search" #trailing>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            aria-label="Borrar búsqueda"
            @click="search = ''"
          />
        </template>
      </UInput>
      <div class="ml-auto flex gap-1">
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-chevrons-down-up" @click="collapseAll">
          Plegar todo
        </UButton>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-chevrons-up-down" @click="expandAll">
          Desplegar
        </UButton>
      </div>
    </div>

    <UiSurface padding="none">
      <div
        v-if="fetchStatus === 'pending' && supportedRuntime"
        class="divide-y divide-[var(--border)]"
        aria-busy="true"
        aria-label="Cargando familias"
      >
        <div v-for="n in 8" :key="n" class="px-4 py-3">
          <div class="h-4 w-1/3 animate-pulse rounded bg-[var(--surface-sunken)]" />
        </div>
      </div>

      <UiEmptyState
        v-else-if="fetchStatus === 'error' || !catData"
        variant="error"
        title="No se han podido consultar las familias"
        description="No podemos confirmar el árbol ni sus recuentos. Comprueba tu sesión y vuelve a intentarlo."
      >
        <UButton v-if="supportedRuntime" @click="reload">Reintentar</UButton>
      </UiEmptyState>
      <UiEmptyState
        v-else-if="!canRead"
        title="Consulta de familias no disponible"
        description="Este entorno no permite confirmar el árbol privado. Los datos ausentes no equivalen a cero familias."
      >
        <UButton v-if="supportedRuntime" @click="reload">Reintentar</UButton>
      </UiEmptyState>

      <UiEmptyState
        v-else-if="search && !visible.length"
        variant="filtered"
        icon="i-lucide-folder-search"
        :title="`Ninguna familia contiene «${search}»`"
        description="Prueba con otra palabra o revisa si está escrita de otra forma."
      >
        <UButton color="neutral" variant="outline" @click="search = ''">Borrar búsqueda</UButton>
      </UiEmptyState>

      <UiEmptyState
        v-else-if="!flat.length"
        icon="i-lucide-folder-tree"
        title="Todavía no hay familias"
        :description="
          canCreate
            ? 'Las familias organizan el catálogo y generan el menú de la tienda. Crea la primera para empezar.'
            : cloudflare && privateCategoryAuthority() && hasCapability('categoryCreate')
              ? 'Puedes crear la primera familia como borrador con el editor. Seguirá pendiente de publicación explícita.'
              : 'La consulta autorizada no devuelve familias con identificador. Tu sesión no permite crear familias.'
        "
      >
        <UButton v-if="canCreate" icon="i-lucide-plus" @click="canCreate && (creating = true)">Nueva familia</UButton>
      </UiEmptyState>

      <ul v-else class="divide-y divide-[var(--border)]" aria-label="Familias y subfamilias" data-category-tree>
        <li
          v-for="row in visible"
          :key="row.id"
          :data-category-id="row.id"
          :data-depth="row.depth"
          class="group flex flex-wrap items-center gap-2 px-3 py-2 transition-colors hover:bg-[var(--canvas)]"
          :style="{ paddingLeft: `${0.75 + Math.min(row.depth, 3) * 0.5}rem` }"
        >
          <button
            v-if="row.hasChildren"
            type="button"
            class="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-sunken)]"
            :aria-expanded="!!matches || !collapsed.has(row.id)"
            :aria-label="`${matches || !collapsed.has(row.id) ? 'Plegar' : 'Desplegar'} ${row.name}`"
            :disabled="!!matches"
            @click="toggle(row.id)"
          >
            <UIcon
              name="i-lucide-chevron-down"
              class="size-4 transition-transform"
              :class="collapsed.has(row.id) && '-rotate-90'"
            />
          </button>
          <span v-else class="w-5 shrink-0" aria-hidden="true" />

          <UIcon
            :name="row.hasChildren ? 'i-lucide-folder-tree' : 'i-lucide-folder'"
            class="size-4 shrink-0 text-neteco-600"
          />

          <span class="min-w-0 flex-1 break-words text-sm font-medium text-[var(--text-strong)]"
            ><span class="sr-only">Nivel {{ row.depth + 1 }}. </span>{{ row.name }}</span
          >
          <UBadge v-if="row.status" color="neutral" variant="subtle">{{
            STATUS_LABELS[row.status] ?? 'Estado no disponible'
          }}</UBadge>

          <span class="tabular shrink-0 text-xs text-[var(--text-muted)]">
            {{ row.count }}
            {{ row.count === 1 ? 'producto' : 'productos' }}
          </span>

          <div
            v-if="canEdit || canDelete"
            class="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          >
            <UButton
              v-if="canEdit"
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-pencil"
              :aria-label="`Editar ${row.name}`"
              @click="startEdit(row)"
            />
            <UButton
              v-if="canDelete"
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :disabled="row.hasChildren || row.count > 0"
              :aria-label="`Eliminar ${row.name}`"
              @click="startRemove(row)"
            />
          </div>
        </li>
      </ul>
    </UiSurface>

    <CategoryCrudEditor
      v-if="cloudflare"
      class="mt-5"
      :view="catData"
      :read-status="fetchStatus"
      :runtime="runtime"
      :authorize="privateCategoryAuthority"
      :refresh="reload"
    />
    <CategoryAttributeDefinitionsEditor
      v-if="cloudflare"
      class="mt-5"
      :runtime="runtime"
      :available="canRead"
      :categories="canRead ? privateView?.flat.map((category) => ({ id: category.id, name: category.name })) : []"
    />

    <p v-if="canDelete" class="mt-2 text-xs text-[var(--text-muted)]">
      Solo se pueden eliminar familias vacías, sin productos ni subfamilias.
    </p>

    <!-- Alta -->
    <UModal v-if="canCreate" v-model:open="creating" title="Nueva familia">
      <template #body>
        <form id="new-family" class="space-y-4" @submit.prevent="createCategory">
          <UFormField label="Nombre" required>
            <UInput v-model="createForm.name" class="w-full" placeholder="Por ejemplo: Desengrasantes" />
          </UFormField>
          <UFormField label="Dentro de" hint="Déjalo en «familia principal» para crear una raíz del menú">
            <USelect v-model="createForm.parentId" :items="parentOptions" class="w-full" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="creating = false">Cancelar</UButton>
          <UButton type="submit" form="new-family" :loading="saving">Crear familia</UButton>
        </div>
      </template>
    </UModal>

    <!-- Editar -->
    <UModal
      v-if="canEdit"
      :open="Boolean(editing)"
      title="Editar familia"
      @update:open="(value) => !value && (editing = null)"
    >
      <template #body>
        <form v-if="editing" id="edit-family" class="space-y-4" @submit.prevent="saveEdit">
          <UFormField label="Nombre" required>
            <UInput v-model="editForm.name" class="w-full" />
          </UFormField>
          <UFormField label="Dentro de" hint="Al mover una familia se mueven también sus subfamilias y sus productos">
            <USelect v-model="editForm.parentId" :items="moveOptions" class="w-full" />
          </UFormField>
          <p class="text-xs text-[var(--text-muted)]">
            Identificador en el ERP: <span class="font-mono">{{ editing.id }}</span
            >. No se puede cambiar: es el vínculo con el importador de catálogo.
          </p>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="editing = null">Cancelar</UButton>
          <UButton type="submit" form="edit-family" :loading="saving">Guardar cambios</UButton>
        </div>
      </template>
    </UModal>

    <!-- Eliminar -->
    <UModal
      v-if="canDelete"
      :open="Boolean(removing)"
      title="Eliminar familia"
      @update:open="(value) => !value && (removing = null)"
    >
      <template #body>
        <p class="text-[var(--text)]">
          Se eliminará <strong>{{ removing?.name }}</strong> del árbol. Desaparecerá del menú de la tienda y de los
          filtros del catálogo.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="removing = null">Cancelar</UButton>
          <UButton color="error" :loading="saving" @click="confirmRemove">Eliminar familia</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
