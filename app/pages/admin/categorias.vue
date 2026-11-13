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
const STATUS_TONES: Record<AdminCatalogStatus, 'neutral' | 'success' | 'warning'> = {
  draft: 'neutral',
  review: 'warning',
  published: 'success',
  hidden: 'neutral',
  discontinued: 'neutral'
}
/* --- Estado de interfaz: apartado visible y familia enviada al editor --- */
const tab = ref('familias')
const TABS = [
  { value: 'familias', label: 'Familias' },
  { value: 'caracteristicas', label: 'Características por familia' }
]
const managed = ref<{ id: number } | null>(null)
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

const canManage = computed(
  () =>
    cloudflare &&
    canRead.value &&
    privateCategoryAuthority() &&
    (hasCapability('categoryUpdate') || hasCapability('categoryDelete'))
)

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
  <AdminPage :count="canRead ? flat.length : undefined" :count-label="flat.length === 1 ? 'familia' : 'familias'">
    <template #actions>
      <AdminButton
        icon="i-lucide-refresh-cw"
        :disabled="!supportedRuntime"
        :loading="fetchStatus === 'pending'"
        @click="reload"
        >Actualizar</AdminButton
      >
      <AdminButton v-if="canCreate" variant="primary" icon="i-lucide-plus" @click="canCreate && (creating = true)"
        >Nueva familia</AdminButton
      >
    </template>
    <div class="adm-stack">
      <UAlert
        v-if="unmapped"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Hay familias importadas que no aparecen en la lista"
        :description="`${unmapped} ${unmapped === 1 ? 'familia no tiene' : 'familias no tienen'} número asignado y no se ${unmapped === 1 ? 'muestra' : 'muestran'}. Sus subfamilias y sus recuentos se conservan.`"
      />

      <AdminTabs v-if="cloudflare && canRead" v-model="tab" :tabs="TABS" label="Apartados de familias" />

      <div
        v-show="tab === 'familias'"
        class="grid items-start gap-5"
        :class="cloudflare && 'xl:grid-cols-[minmax(0,1fr)_24rem]'"
      >
        <div class="adm-card adm-tablecard min-w-0">
          <div v-if="canRead" class="adm-tablecard__bar">
            <div class="adm-toolbar" role="search">
              <label class="adm-toolbar__search">
                <UIcon name="i-lucide-search" class="size-4" />
                <input
                  v-model="search"
                  type="search"
                  placeholder="Buscar familia"
                  aria-label="Buscar familia"
                  data-slot="adm-search"
                />
              </label>
              <AdminButton
                v-if="search"
                variant="ghost"
                size="sm"
                icon="i-lucide-x"
                label="Borrar búsqueda"
                @click="search = ''"
              />
              <div class="adm-toolbar__end">
                <AdminButton variant="ghost" size="sm" icon="i-lucide-chevrons-down-up" @click="collapseAll"
                  >Plegar todo</AdminButton
                >
                <AdminButton variant="ghost" size="sm" icon="i-lucide-chevrons-up-down" @click="expandAll"
                  >Desplegar</AdminButton
                >
              </div>
            </div>
          </div>

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

          <AdminEmptyState
            v-else-if="fetchStatus === 'error' || !catData"
            data-empty="error"
            role="alert"
            variant="error"
            title="No se han podido consultar las familias"
            description="Comprueba que tu sesión sigue abierta y vuelve a intentarlo."
          >
            <AdminButton v-if="supportedRuntime" icon="i-lucide-rotate-cw" @click="reload">Reintentar</AdminButton>
          </AdminEmptyState>
          <AdminEmptyState
            v-else-if="!canRead"
            data-empty="empty"
            role="status"
            icon="i-lucide-lock"
            title="Consulta de familias no disponible"
            description="Ahora mismo no podemos mostrarte las familias. No significa que no haya ninguna: vuelve a intentarlo o revisa tus permisos."
          >
            <AdminButton v-if="supportedRuntime" icon="i-lucide-rotate-cw" @click="reload">Reintentar</AdminButton>
          </AdminEmptyState>

          <AdminEmptyState
            v-else-if="search && !visible.length"
            data-empty="filtered"
            role="status"
            variant="filtered"
            :title="`Ninguna familia contiene «${search}»`"
            description="Prueba con otra palabra o revisa si está escrita de otra forma."
          >
            <AdminButton @click="search = ''">Borrar búsqueda</AdminButton>
          </AdminEmptyState>

          <AdminEmptyState
            v-else-if="!flat.length"
            data-empty="empty"
            role="status"
            icon="i-lucide-folder-tree"
            title="Todavía no hay familias"
            :description="
              canCreate
                ? 'Las familias organizan el catálogo y generan el menú de la tienda. Crea la primera para empezar.'
                : cloudflare && privateCategoryAuthority() && hasCapability('categoryCreate')
                  ? 'Crea la primera familia desde el panel de la derecha. Se guardará como borrador hasta que la publiques.'
                  : 'No hay familias que mostrar. Tu sesión no permite crear familias.'
            "
          >
            <AdminButton v-if="canCreate" variant="primary" icon="i-lucide-plus" @click="canCreate && (creating = true)"
              >Nueva familia</AdminButton
            >
          </AdminEmptyState>

          <ul v-else class="divide-y divide-[var(--border)]" aria-label="Familias y subfamilias" data-category-tree>
            <li
              v-for="row in visible"
              :key="row.id"
              :data-category-id="row.id"
              :data-depth="row.depth"
              class="group flex min-h-11 flex-wrap items-center gap-2 px-3 py-1.5 transition-colors hover:bg-[var(--canvas)]"
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
              <AdminBadge v-if="row.status" :tone="STATUS_TONES[row.status] ?? 'neutral'">{{
                STATUS_LABELS[row.status] ?? 'Estado no disponible'
              }}</AdminBadge>

              <span class="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
                {{ row.count }}
                {{ row.count === 1 ? 'producto' : 'productos' }}
              </span>

              <div v-if="canEdit || canDelete || canManage" class="flex shrink-0 gap-0.5">
                <AdminButton
                  v-if="canManage"
                  variant="ghost"
                  size="sm"
                  icon="i-lucide-pencil"
                  :label="`Gestionar ${row.name}`"
                  @click="managed = { id: row.id }"
                />
                <AdminButton
                  v-if="canEdit"
                  variant="ghost"
                  size="sm"
                  icon="i-lucide-pencil"
                  :label="`Editar ${row.name}`"
                  @click="startEdit(row)"
                />
                <AdminButton
                  v-if="canDelete"
                  variant="ghost"
                  size="sm"
                  icon="i-lucide-trash-2"
                  :disabled="row.hasChildren || row.count > 0"
                  :label="`Eliminar ${row.name}`"
                  @click="startRemove(row)"
                />
              </div>
            </li>
          </ul>

          <p
            v-if="canRead && flat.length"
            class="adm-help border-t border-[var(--border)] px-4 py-2.5"
            data-category-note
          >
            <template v-if="cloudflare"
              >Se muestran las familias en todos los estados. El recuento suma los productos de sus subfamilias, no
              existencias.</template
            >
            <template v-else-if="canDelete"
              >Solo se pueden eliminar familias vacías, sin productos ni subfamilias.</template
            >
            <template v-else>El recuento suma los productos de sus subfamilias.</template>
          </p>
        </div>

        <CategoryCrudEditor
          v-if="cloudflare"
          :view="catData"
          :read-status="fetchStatus"
          :runtime="runtime"
          :authorize="privateCategoryAuthority"
          :refresh="reload"
          :focus="managed"
        />
      </div>

      <div v-if="cloudflare" v-show="tab === 'caracteristicas'">
        <CategoryAttributeDefinitionsEditor
          :runtime="runtime"
          :available="canRead"
          :categories="canRead ? privateView?.flat.map((category) => ({ id: category.id, name: category.name })) : []"
        />
      </div>

      <!-- Alta -->
      <UModal v-if="canCreate" v-model:open="creating" title="Nueva familia">
        <template #body>
          <form id="new-family" class="space-y-4" @submit.prevent="createCategory">
            <UFormField label="Nombre" required>
              <UInput v-model="createForm.name" class="w-full" placeholder="Por ejemplo: desengrasantes" />
            </UFormField>
            <UFormField label="Dentro de" hint="Déjalo en «familia principal» para crear una raíz del menú">
              <USelect v-model="createForm.parentId" :items="parentOptions" class="w-full" />
            </UFormField>
          </form>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <AdminButton @click="creating = false">Cancelar</AdminButton>
            <AdminButton variant="primary" type="submit" form="new-family" :loading="saving">Crear familia</AdminButton>
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
            <p class="adm-help">
              Número de familia en el programa de gestión: <span class="font-mono">{{ editing.id }}</span
              >. No se puede cambiar porque enlaza con la importación del catálogo.
            </p>
          </form>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <AdminButton @click="editing = null">Cancelar</AdminButton>
            <AdminButton variant="primary" type="submit" form="edit-family" :loading="saving"
              >Guardar cambios</AdminButton
            >
          </div>
        </template>
      </UModal>

      <!-- Eliminar -->
      <AdminConfirm
        v-if="canDelete"
        :open="Boolean(removing)"
        title="Eliminar familia"
        confirm-label="Eliminar familia"
        danger
        :loading="saving"
        @update:open="(value: boolean) => !value && (removing = null)"
        @confirm="confirmRemove"
      >
        <p class="text-[var(--text)]">
          Se eliminará <strong>{{ removing?.name }}</strong> del árbol. Desaparecerá del menú de la tienda y de los
          filtros del catálogo.
        </p>
      </AdminConfirm>
    </div>
  </AdminPage>
</template>
