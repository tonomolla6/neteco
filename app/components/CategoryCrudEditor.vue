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
          ? 'Familia borrador creada. Sigue pendiente de publicación explícita; no está lista para vender.'
          : 'Alta de borrador confirmada. La creación no publica; el árbol muestra el estado vigente.'
        : command.action === 'delete_category'
          ? 'Comando de retirada confirmado. Su identidad, historial y direcciones anteriores se conservan; el árbol muestra el estado vigente.'
          : 'Cambio confirmado con una nueva lectura. Las direcciones anteriores solo redirigen mientras la familia sea pública.'
  } catch (cause) {
    if (!alive || (!acknowledged && current !== generation)) return
    if (!acknowledged && (knownCode || errorCode(cause))) {
      intent = null
      uncertain.value = false
      blocked.value = true
      message.value = 'El cambio no se ha confirmado. Actualiza la lectura antes de preparar otra solicitud.'
    } else {
      uncertain.value = true
      message.value =
        'No podemos confirmar el resultado. Se conserva la solicitud original para un reintento manual con la misma clave.'
    }
  } finally {
    pending = false
    if (alive) {
      busy.value = false
      if (intent) {
        uncertain.value = true
        if (!message.value)
          message.value =
            'Cambió la lectura o la autorización. La solicitud original se conserva sin reintento automático.'
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
    message.value = 'No se ha podido preparar una solicitud segura.'
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
      ? 'Lectura actualizada. Sigue pendiente la solicitud original.'
      : 'Lectura actualizada; prepara de nuevo el cambio.'
  } catch {
    if (alive) message.value = 'No se han podido consultar las familias. Reintenta la lectura manualmente.'
  } finally {
    reading = false
    if (alive) reloading.value = false
  }
}
</script>

<template>
  <section
    class="mb-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
    :aria-labelledby="`${prefix}-heading`"
  >
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 :id="`${prefix}-heading`" class="text-lg font-semibold text-[var(--text-strong)]">
        Gestión editorial de familias
      </h2>
      <UButton
        v-if="writable && categoryView?.capabilities.categoryCreate"
        data-category-create
        :disabled="busy || reloading || uncertain || blocked"
        @click="begin('create_category')"
        >Nueva familia borrador</UButton
      >
    </div>
    <p class="mt-1 text-sm text-[var(--text-muted)]">
      Crear no publica. Mover no puede hacer pública una rama oculta. Eliminar solo retira familias vacías y conserva su
      historial.
    </p>
    <p v-if="readStatus === 'pending'" class="mt-3 text-sm" role="status">Consultando el árbol…</p>
    <p v-else-if="!categoryView" class="mt-3 text-sm" role="alert">
      No hay una lectura confirmada del árbol. No se pueden preparar cambios.
    </p>
    <p
      v-else-if="!writable || !Object.values(capabilities).some((key) => categoryView?.capabilities[key])"
      class="mt-3 text-sm"
      role="status"
    >
      Tu sesión no permite administrar familias. La consulta no concede permiso de escritura.
    </p>
    <div
      v-if="
        writable &&
        categoryView &&
        (categoryView.capabilities.categoryUpdate || categoryView.capabilities.categoryDelete)
      "
      class="mt-4 space-y-3"
      aria-label="Acciones editoriales de familias"
    >
      <div class="grid gap-3 sm:grid-cols-2">
        <label :for="`${prefix}-search`" class="block text-sm"
          >Buscar familia a gestionar<input
            :id="`${prefix}-search`"
            v-model="search"
            data-category-search
            type="search"
            maxlength="160"
            class="category-field"
            :disabled="busy || reloading || uncertain || blocked"
        /></label>
        <label :for="`${prefix}-target`" class="block text-sm"
          >Familia a gestionar<select
            :id="`${prefix}-target`"
            v-model="selection"
            data-category-target
            class="category-field"
            :disabled="busy || reloading || uncertain || blocked"
          >
            <option value="">Selecciona una familia</option>
            <option v-for="row in choices" :key="row.id" :value="String(row.id)">{{ row.name }}</option>
          </select></label
        >
      </div>
      <div v-if="selectedCategory" class="flex flex-wrap gap-2">
        <UButton
          v-if="categoryView.capabilities.categoryUpdate && selectedCategory.status !== 'discontinued'"
          color="neutral"
          variant="outline"
          :data-category-edit="selectedCategory.id"
          :disabled="busy || reloading || uncertain || blocked"
          @click="begin('update_category', selectedCategory.id)"
          >Editar {{ selectedCategory.name }}</UButton
        >
        <UButton
          v-if="categoryView.capabilities.categoryDelete && selectedCategory.status !== 'discontinued'"
          color="neutral"
          variant="ghost"
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
          >Retirar {{ selectedCategory.name }}</UButton
        >
      </div>
    </div>
    <form v-if="mode && writable && categoryView" class="mt-5 space-y-4" :aria-busy="busy" @submit.prevent="submit">
      <fieldset :disabled="busy || reloading || uncertain || blocked || !permitted(mode, baseline)" class="space-y-3">
        <legend class="font-semibold">
          {{
            mode === 'create_category'
              ? 'Nueva familia borrador'
              : mode === 'delete_category'
                ? 'Retirar familia vacía'
                : 'Renombrar o mover familia'
          }}
        </legend>
        <template v-if="mode !== 'delete_category'">
          <label :for="`${prefix}-name`" class="block text-sm"
            >Nombre<input
              :id="`${prefix}-name`"
              v-model="name"
              data-category-name
              required
              minlength="2"
              maxlength="160"
              class="category-field"
          /></label>
          <label :for="`${prefix}-parent`" class="block text-sm"
            >Dentro de<select :id="`${prefix}-parent`" v-model="parent" data-category-parent class="category-field">
              <option v-if="mode === 'update_category'" value="keep">Conservar el padre real actual</option>
              <option value="root">Familia principal</option>
              <option v-for="entry in parents" :key="entry.id" :value="String(entry.id)">
                {{ entry.name }} ({{ entry.status }})
              </option>
            </select></label
          >
          <p v-if="baseline && !baseline.parentMapped" class="text-xs text-[var(--text-muted)]">
            El padre real no tiene identificador heredado. Renombrar conserva ese vínculo; no se usa el padre proyectado
            del árbol como sustituto.
          </p>
          <p class="text-xs text-[var(--text-muted)]">
            Las direcciones anteriores quedan vinculadas a la misma identidad. Solo redirigen cuando toda su ascendencia
            está publicada.
          </p>
        </template>
        <label v-else class="flex items-start gap-2 text-sm"
          ><input v-model="confirmation" data-category-confirm type="checkbox" required />Confirmo que se retire esta
          familia vacía sin borrar su identidad ni historial.</label
        >
        <label :for="`${prefix}-reason`" class="block text-sm"
          >Motivo auditable<textarea
            :id="`${prefix}-reason`"
            v-model="reason"
            data-category-reason
            required
            minlength="3"
            maxlength="500"
            rows="2"
            class="category-field"
          />
        </label>
      </fieldset>
      <div class="flex gap-2">
        <UButton type="submit" data-category-submit :disabled="!canSubmit" :loading="busy">{{
          mode === 'delete_category' ? 'Confirmar retirada' : 'Guardar cambio editorial'
        }}</UButton
        ><UButton color="neutral" variant="ghost" :disabled="busy || uncertain" @click="cancel">Cancelar</UButton>
      </div>
    </form>
    <p v-if="message" role="status" aria-live="polite" class="mt-4 text-sm">{{ message }}</p>
    <div class="mt-4 flex flex-wrap gap-2">
      <UButton
        v-if="uncertain"
        data-category-retry
        color="neutral"
        variant="outline"
        :disabled="!canRetry"
        @click="retry"
        >Reintentar la misma solicitud</UButton
      >
      <UButton
        data-category-read
        color="neutral"
        variant="ghost"
        :disabled="runtime !== 'cloudflare' || busy || reloading || !authorized()"
        :loading="reloading"
        @click="reload"
        >Actualizar lectura</UButton
      >
    </div>
  </section>
</template>

<style scoped>
.category-field {
  width: 100%;
  display: block;
  margin-top: 0.3rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--canvas);
  color: var(--text);
}
.category-field:focus-visible {
  outline: 2px solid var(--color-neteco-500);
  outline-offset: 2px;
}
</style>
