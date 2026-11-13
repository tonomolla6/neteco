<script setup lang="ts">
import {
  parseD1CategoryAdminView,
  createCategoryInputSchema,
  updateCategoryInputSchema,
  deleteCategoryInputSchema,
  catalogCategoryReceiptSchema,
  type CatalogCategoryAction,
  type CatalogCategorySnapshot
} from '~~/shared/catalog-category-commands'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'

const props = defineProps<{
  view: unknown
  readStatus: string
  runtime: unknown
  authorize: (identity?: { id: number; uuid: string; version: number }) => boolean
  refresh: () => Promise<unknown>
  /** Familia elegida en el árbol de la página: se preselecciona para gestionarla. */
  focus?: { id: number } | null
}>()
const prefix = useId()
function confirmed() {
  return props.runtime === 'cloudflare' && props.readStatus === 'success' ? parseD1CategoryAdminView(props.view) : null
}
const categoryView = computed(confirmed)
const capabilities = {
  create_category: 'categoryCreate',
  update_category: 'categoryUpdate',
  delete_category: 'categoryDelete'
} as const
function authorized(identity?: { id: number; uuid: string; version: number }) {
  try {
    return props.authorize(identity) === true
  } catch {
    return false
  }
}
function permitted(action: CatalogCategoryAction, target?: CatalogCategorySnapshot | null, replay = false) {
  const data = confirmed()
  if (!data || data.capabilities[capabilities[action]] !== true) return false
  if (action === 'create_category') return authorized()
  if (!target) return false
  const current = data.flat.find((row) => row.id === target.id && row.authoring.uuid === target.uuid)?.authoring
  if (!current || (!replay && (current.version !== target.version || current.status === 'discontinued'))) return false
  return authorized({ id: current.id, uuid: current.uuid, version: current.version })
}
const writable = computed(() => !!categoryView.value && authorized())
const selection = ref(''),
  search = ref('')
const selectedCategory = computed(() => categoryView.value?.flat.find((row) => String(row.id) === selection.value))
const choices = computed(() => {
  const term = search.value.trim().toLowerCase()
  return (
    categoryView.value?.flat.filter(
      (row) => String(row.id) === selection.value || !term || row.name.toLowerCase().includes(term)
    ) ?? []
  )
})
const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  review: 'En revisión',
  published: 'Publicada',
  hidden: 'Oculta',
  discontinued: 'Retirada'
}
const mode = ref<CatalogCategoryAction | null>(null)
const baseline = ref<CatalogCategorySnapshot | null>(null)
const name = ref(''),
  reason = ref(''),
  parent = ref('keep'),
  confirmation = ref(false)
const busy = ref(false),
  reloading = ref(false),
  uncertain = ref(false),
  blocked = ref(false)
const message = ref('')
let alive = true,
  pending = false,
  reading = false,
  generation = 0
type Intent = Readonly<{
  action: CatalogCategoryAction
  path: string
  method: 'POST' | 'PUT' | 'DELETE'
  payload: string
  key: string
  target: CatalogCategorySnapshot | null
}>
let intent: Intent | null = null
watch(selection, () => {
  if (!pending && !reading && !intent) {
    mode.value = null
    baseline.value = null
    message.value = ''
  }
})
watch([() => props.view, () => props.readStatus, () => props.runtime, writable], () => {
  generation++
})
watch(
  () => props.focus,
  (target) => {
    if (!target || pending || reading || intent || uncertain.value || blocked.value) return
    if (!categoryView.value?.flat.some((row) => row.id === target.id)) return
    search.value = ''
    selection.value = String(target.id)
  }
)
onBeforeUnmount(() => {
  alive = false
  generation++
})

const parents = computed(() => {
  const data = categoryView.value
  if (!data) return []
  const excluded = new Set<number>()
  if (baseline.value) {
    excluded.add(baseline.value.id)
    for (const row of data.flat) {
      let current = row
      while (current.parentId !== null) {
        if (excluded.has(current.parentId)) {
          excluded.add(row.id)
          break
        }
        const ancestor = data.flat.find((entry) => entry.id === current.parentId)
        if (!ancestor) break
        current = ancestor
      }
    }
  }
  return data.flat.filter((row) => row.status !== 'discontinued' && !excluded.has(row.id))
})
function prepared() {
  const action = mode.value,
    target = baseline.value
  if (!action || !permitted(action, target)) return null
  const input: Record<string, unknown> = { expectedVersion: target?.version ?? 0, reason: reason.value }
  if (action !== 'delete_category') {
    input.name = name.value
    if (parent.value !== 'keep') {
      if (parent.value === 'root') input.parentId = null
      else {
        const id = Number(parent.value)
        if (String(id) !== parent.value || !parents.value.some((entry) => entry.id === id)) return null
        input.parentId = id
      }
    }
  } else if (!confirmation.value || !target || target.directChildren !== 0 || target.directProducts !== 0) return null
  const schema =
    action === 'create_category'
      ? createCategoryInputSchema
      : action === 'update_category'
        ? updateCategoryInputSchema
        : deleteCategoryInputSchema
  const parsed = schema.safeParse(input)
  return parsed.success ? parsed.data : null
}
const canSubmit = computed(() => !busy.value && !reloading.value && !uncertain.value && !blocked.value && !!prepared())
const canRetry = computed(
  () => uncertain.value && !!intent && !busy.value && !reloading.value && permitted(intent.action, intent.target, true)
)
function begin(action: CatalogCategoryAction, id?: number) {
  if (!alive || pending || reading || intent || uncertain.value || blocked.value) return
  const target = id === undefined ? null : confirmed()?.flat.find((row) => row.id === id)?.authoring
  if (!permitted(action, target)) return
  if (action === 'delete_category' && (!target || target.directChildren !== 0 || target.directProducts !== 0)) return
  baseline.value = target ?? null
  mode.value = action
  name.value = target?.name ?? ''
  // KEEP deliberately omits parentId. The projected legacy parent is not the
  // actual parent when imports contain an unmapped intermediate category.
  parent.value = action === 'create_category' ? 'root' : 'keep'
  reason.value = ''
  confirmation.value = false
  message.value = ''
}
function cancel() {
  if (pending || reading || intent || uncertain.value) return
  mode.value = null
  baseline.value = null
  message.value = ''
}
const deterministicCodes = new Set([
  'invalid_input',
  'not_found',
  'version_conflict',
  'idempotency_conflict',
  'reference_unavailable',
  'invalid_hierarchy',
  'visibility_expansion',
  'category_not_editable',
  'category_not_empty',
  'conflict',
  'rate_limited'
])
function domainCode(value: unknown) {
  try {
    const data = catalogPolicyOwnJson(value)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const error: unknown = Object.getOwnPropertyDescriptor(data, 'error')?.value
    const code: unknown =
      error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null
    return typeof code === 'string' && deterministicCodes.has(code) ? code : null
  } catch {
    return null
  }
}
function errorCode(value: unknown) {
  try {
    return value && typeof value === 'object' ? domainCode(Object.getOwnPropertyDescriptor(value, 'data')?.value) : null
  } catch {
    return null
  }
}
function matchesReceipt(response: unknown, command: Intent) {
  const parsed = catalogCategoryReceiptSchema.safeParse(response)
  if (!parsed.success || parsed.data.action !== command.action) return null
  const receipt = parsed.data
  if (command.target) {
    if (
      receipt.categoryId !== command.target.id ||
      receipt.categoryUuid !== command.target.uuid ||
      receipt.categoryVersion !== command.target.version + 1 ||
      receipt.status !== (command.action === 'delete_category' ? 'discontinued' : command.target.status)
    )
      return null
  } else if (
    receipt.categoryVersion !== 1 ||
    receipt.status !== 'draft' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(receipt.categoryUuid)
  )
    return null
  return receipt
}
async function send(command: Intent, replay = false) {
  if (!alive || pending || reading || !permitted(command.action, command.target, replay)) return
  pending = true
  busy.value = true
  message.value = ''
  const current = generation
  let knownCode: string | null = null,
    acknowledged = false
  try {
    const response: unknown = await $fetch(command.path, {
      method: command.method,
      body: JSON.parse(command.payload),
      retry: 0,
      headers: { Origin: window.location.origin, 'Idempotency-Key': command.key },
      onResponseError({ response }) {
        if (response.status >= 400 && response.status < 500) knownCode = domainCode(response._data)
      }
    })
    if (!alive || current !== generation || !permitted(command.action, command.target, true)) return
    const receipt = matchesReceipt(response, command)
    if (!receipt) throw new Error('unconfirmed_receipt')
    acknowledged = true
    // A receipt is historical evidence, never the new tree. Refresh the current
    // authorized GET and confirm immutable identity before reporting success.
    await props.refresh()
    await nextTick()
    if (!alive || !permitted(command.action, command.target, true)) return
    const row = confirmed()?.flat.find((entry) => entry.id === receipt.categoryId)
    if (!row || row.authoring.uuid !== receipt.categoryUuid || row.authoring.version < receipt.categoryVersion)
      throw new Error('unconfirmed_read')
    intent = null
    uncertain.value = false
    blocked.value = false
    mode.value = null
    baseline.value = null
    message.value =
      command.action === 'create_category'
        ? row.status === 'draft'
          ? 'Familia creada como borrador. Sigue pendiente de publicación explícita: todavía no se ve en la tienda.'
          : 'Familia creada. Crear no la publica; el árbol muestra el estado vigente.'
        : command.action === 'delete_category'
          ? 'Familia retirada. Su identidad, historial y direcciones anteriores se conservan; el árbol muestra el estado vigente.'
          : 'Cambio confirmado. Las direcciones anteriores de la familia siguen funcionando mientras esté publicada.'
  } catch (cause) {
    if (!alive || (!acknowledged && current !== generation)) return
    if (!acknowledged && (knownCode || errorCode(cause))) {
      intent = null
      uncertain.value = false
      blocked.value = true
      message.value = 'El cambio no se ha guardado. Pulsa «Actualizar» antes de volver a intentarlo.'
    } else {
      uncertain.value = true
      message.value = 'No podemos confirmar si el cambio se ha guardado. Puedes reintentarlo sin riesgo de duplicarlo.'
    }
  } finally {
    pending = false
    if (alive) {
      busy.value = false
      if (intent) {
        uncertain.value = true
        if (!message.value)
          message.value =
            'Los datos o tus permisos han cambiado mientras se guardaba. El cambio queda pendiente: reinténtalo cuando quieras.'
      }
    }
  }
}
async function submit() {
  const input = prepared(),
    action = mode.value
  if (!alive || pending || reading || !canSubmit.value || !input || !action || intent) return
  try {
    intent = Object.freeze({
      action,
      payload: JSON.stringify(input),
      key: randomId(),
      target: baseline.value ? Object.freeze({ ...baseline.value }) : null,
      path: action === 'create_category' ? '/api/admin/categories' : `/api/admin/categories/${baseline.value!.id}`,
      method: action === 'create_category' ? 'POST' : action === 'update_category' ? 'PUT' : 'DELETE'
    })
  } catch {
    message.value = 'No se ha podido preparar el cambio. Vuelve a intentarlo.'
    return
  }
  await send(intent)
}
async function retry() {
  if (alive && canRetry.value && intent) await send(intent, true)
}
async function reload() {
  if (!alive || pending || reading || props.runtime !== 'cloudflare' || !authorized()) return
  reading = true
  reloading.value = true
  try {
    await props.refresh()
    await nextTick()
    if (!alive || !confirmed() || !authorized()) return
    if (!intent) {
      blocked.value = false
      mode.value = null
      baseline.value = null
    }
    message.value = intent
      ? 'Familias actualizadas. El cambio anterior sigue pendiente de confirmar.'
      : 'Familias actualizadas. Ya puedes preparar el cambio de nuevo.'
  } catch {
    if (alive) message.value = 'No se han podido consultar las familias. Vuelve a pulsar «Actualizar».'
  } finally {
    reading = false
    if (alive) reloading.value = false
  }
}
</script>

<template>
  <AdminCard
    :aria-labelledby="`${prefix}-heading`"
    description="Crear no publica: las familias nuevas quedan en borrador. Solo se pueden retirar familias vacías."
  >
    <template #title>
      <span :id="`${prefix}-heading`">Crear, renombrar o retirar familias</span>
    </template>
    <template v-if="writable && categoryView?.capabilities.categoryCreate" #actions>
      <button
        type="button"
        class="adm-btn adm-btn--primary adm-btn--sm"
        data-category-create
        :disabled="busy || reloading || uncertain || blocked"
        @click="begin('create_category')"
      >
        <UIcon name="i-lucide-plus" class="size-4 shrink-0" />Nueva familia borrador
      </button>
    </template>

    <div class="adm-stack">
      <p v-if="readStatus === 'pending'" class="adm-help" role="status">Cargando las familias…</p>
      <div v-else-if="!categoryView" role="alert">
        <UAlert
          color="warning"
          variant="subtle"
          title="No se han podido cargar las familias"
          description="Hasta que se carguen no se pueden hacer cambios."
        />
      </div>
      <p
        v-else-if="!writable || !Object.values(capabilities).some((key) => categoryView?.capabilities[key])"
        class="adm-help"
        role="status"
      >
        Tu usuario puede ver las familias, pero no modificarlas.
      </p>

      <div
        v-if="
          writable &&
          categoryView &&
          (categoryView.capabilities.categoryUpdate || categoryView.capabilities.categoryDelete)
        "
        class="grid gap-3"
        aria-label="Acciones editoriales de familias"
      >
        <div class="adm-form-grid">
          <div class="adm-field">
            <label :for="`${prefix}-search`" class="adm-label">Buscar familia</label>
            <input
              :id="`${prefix}-search`"
              v-model="search"
              data-category-search
              type="search"
              maxlength="160"
              class="adm-input w-full"
              placeholder="Escribe parte del nombre"
              :disabled="busy || reloading || uncertain || blocked"
            />
          </div>
          <div class="adm-field">
            <label :for="`${prefix}-target`" class="adm-label">Familia</label>
            <select
              :id="`${prefix}-target`"
              v-model="selection"
              data-category-target
              class="adm-input w-full"
              :disabled="busy || reloading || uncertain || blocked"
            >
              <option value="">Selecciona una familia</option>
              <option v-for="row in choices" :key="row.id" :value="String(row.id)">{{ row.name }}</option>
            </select>
          </div>
        </div>
        <div v-if="selectedCategory" class="flex flex-wrap gap-2">
          <button
            v-if="categoryView.capabilities.categoryUpdate && selectedCategory.status !== 'discontinued'"
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :data-category-edit="selectedCategory.id"
            :disabled="busy || reloading || uncertain || blocked"
            @click="begin('update_category', selectedCategory.id)"
          >
            <UIcon name="i-lucide-pencil" class="size-4 shrink-0" />Editar {{ selectedCategory.name }}
          </button>
          <button
            v-if="categoryView.capabilities.categoryDelete && selectedCategory.status !== 'discontinued'"
            type="button"
            class="adm-btn adm-btn--danger-soft adm-btn--sm"
            :data-category-delete="selectedCategory.id"
            :disabled="
              busy ||
              reloading ||
              uncertain ||
              blocked ||
              selectedCategory.authoring.directChildren > 0 ||
              selectedCategory.authoring.directProducts > 0
            "
            @click="begin('delete_category', selectedCategory.id)"
          >
            <UIcon name="i-lucide-archive" class="size-4 shrink-0" />Retirar {{ selectedCategory.name }}
          </button>
          <p
            v-if="
              selectedCategory.status !== 'discontinued' &&
              (selectedCategory.authoring.directChildren > 0 || selectedCategory.authoring.directProducts > 0)
            "
            class="adm-help w-full"
          >
            Para retirarla, antes debe quedarse sin productos ni subfamilias.
          </p>
        </div>
      </div>

      <form
        v-if="mode && writable && categoryView"
        class="grid gap-4 border-t border-[var(--border)] pt-4"
        :aria-busy="busy"
        @submit.prevent="submit"
      >
        <fieldset
          :disabled="busy || reloading || uncertain || blocked || !permitted(mode, baseline)"
          class="grid gap-3"
        >
          <legend class="mb-3 text-sm font-semibold text-[var(--text-strong)]">
            {{
              mode === 'create_category'
                ? 'Nueva familia borrador'
                : mode === 'delete_category'
                  ? `Retirar «${baseline?.name ?? ''}»`
                  : 'Renombrar o mover la familia'
            }}
          </legend>
          <template v-if="mode !== 'delete_category'">
            <div class="adm-field">
              <label :for="`${prefix}-name`" class="adm-label">Nombre</label>
              <input
                :id="`${prefix}-name`"
                v-model="name"
                data-category-name
                required
                minlength="2"
                maxlength="160"
                class="adm-input w-full"
              />
            </div>
            <div class="adm-field">
              <label :for="`${prefix}-parent`" class="adm-label">Dentro de</label>
              <select :id="`${prefix}-parent`" v-model="parent" data-category-parent class="adm-input w-full">
                <option v-if="mode === 'update_category'" value="keep">Dejarla donde está</option>
                <option value="root">Familia principal (sin familia superior)</option>
                <option v-for="entry in parents" :key="entry.id" :value="String(entry.id)">
                  {{ entry.name }} ({{ (STATUS_LABELS[entry.status] ?? 'Sin estado').toLowerCase() }})
                </option>
              </select>
              <p v-if="baseline && !baseline.parentMapped" class="adm-help">
                Esta familia cuelga de otra que no aparece en la lista. Si la dejas donde está, conserva ese vínculo.
              </p>
              <p class="adm-help">
                Mover una familia no la publica. Sus direcciones web anteriores siguen llevando a ella mientras esté
                publicada.
              </p>
            </div>
          </template>
          <label v-else class="adm-check items-start"
            ><input v-model="confirmation" data-category-confirm type="checkbox" required class="mt-0.5" /><span
              >Confirmo que quiero retirar esta familia vacía. Su historial se conserva.</span
            ></label
          >
          <div class="adm-field">
            <label :for="`${prefix}-reason`" class="adm-label">Motivo del cambio</label>
            <textarea
              :id="`${prefix}-reason`"
              v-model="reason"
              data-category-reason
              required
              minlength="3"
              maxlength="500"
              rows="2"
              class="adm-input w-full"
            />
            <p class="adm-help">Queda guardado en el historial de cambios.</p>
          </div>
        </fieldset>
        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy || uncertain" @click="cancel">
            Cancelar
          </button>
          <button
            type="submit"
            data-category-submit
            class="adm-btn"
            :class="mode === 'delete_category' ? 'adm-btn--danger' : 'adm-btn--primary'"
            :disabled="!canSubmit || busy"
          >
            <UIcon v-if="busy" name="i-lucide-loader-circle" class="size-4 animate-spin" />
            {{ mode === 'delete_category' ? 'Retirar familia' : 'Guardar' }}
          </button>
        </div>
      </form>

      <div v-if="message" role="status" aria-live="polite">
        <UAlert :color="uncertain || blocked ? 'warning' : 'neutral'" variant="subtle" :title="message" />
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          v-if="uncertain"
          type="button"
          data-category-retry
          class="adm-btn adm-btn--secondary adm-btn--sm"
          :disabled="!canRetry"
          @click="retry"
        >
          Reintentar el cambio
        </button>
        <button
          type="button"
          data-category-read
          class="adm-btn adm-btn--ghost adm-btn--sm"
          :disabled="runtime !== 'cloudflare' || busy || reloading || !authorized()"
          @click="reload"
        >
          <UIcon
            :name="reloading ? 'i-lucide-loader-circle' : 'i-lucide-refresh-cw'"
            class="size-4 shrink-0"
            :class="reloading && 'animate-spin'"
          />Actualizar
        </button>
      </div>
    </div>
  </AdminCard>
</template>
