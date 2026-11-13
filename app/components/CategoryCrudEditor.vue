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
  /** Familia elegida en el árbol de la página: abre su edición o su retirada. */
  focus?: { id: number; action?: 'edit' | 'retire' } | null
  /** Muestra «Nueva familia» en la cabecera de la pantalla (solo en el apartado de familias). */
  headerActions?: boolean
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
watch([() => props.view, () => props.readStatus, () => props.runtime, writable], () => {
  generation++
})
watch(
  () => props.focus,
  (target) => {
    if (!target || pending || reading || intent || uncertain.value || blocked.value) return
    const row = categoryView.value?.flat.find((entry) => entry.id === target.id)
    if (!row) return
    if (target.action !== 'retire') return begin('update_category', row.id)
    if (row.authoring.directChildren > 0 || row.authoring.directProducts > 0) {
      message.value = `Para retirar «${row.name}», antes debe quedarse sin productos ni subfamilias.`
      return
    }
    begin('delete_category', row.id)
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
/** Alta y edición van en un panel lateral; la retirada, en una ventana de confirmación. */
const formDrawer = computed({
  get: () => mode.value === 'create_category' || mode.value === 'update_category',
  set: (open: boolean) => {
    if (!open) cancel()
  }
})
const retireConfirm = computed({
  get: () => mode.value === 'delete_category' && !uncertain.value && !blocked.value,
  set: (open: boolean) => {
    if (!open) cancel()
  }
})
async function confirmRetire() {
  confirmation.value = true
  await submit()
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
  <AdminPageActions v-if="headerActions && writable && categoryView?.capabilities.categoryCreate">
    <button
      type="button"
      class="adm-btn adm-btn--primary"
      data-category-create
      :disabled="busy || reloading || uncertain || blocked"
      @click="begin('create_category')"
    >
      <UIcon name="i-lucide-plus" class="size-4 shrink-0" />Nueva familia
    </button>
  </AdminPageActions>

  <div
    v-if="!formDrawer && !retireConfirm && (message || uncertain || blocked)"
    class="adm-stack"
    :aria-labelledby="`${prefix}-heading`"
    role="status"
    aria-live="polite"
  >
    <span :id="`${prefix}-heading`" class="sr-only">Cambios en las familias</span>
    <UAlert
      :color="uncertain || blocked ? 'warning' : 'neutral'"
      variant="subtle"
      :icon="uncertain || blocked ? 'i-lucide-triangle-alert' : 'i-lucide-info'"
      :title="message || 'Actualiza las familias antes de preparar otro cambio.'"
    />
    <div v-if="uncertain || blocked" class="flex flex-wrap gap-2">
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
        class="adm-btn adm-btn--secondary adm-btn--sm"
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
  <p
    v-else-if="
      categoryView && (!writable || !Object.values(capabilities).some((key) => categoryView?.capabilities[key]))
    "
    class="adm-help"
    role="status"
  >
    Tu usuario puede ver las familias, pero no modificarlas.
  </p>

  <AdminDrawer
    v-model:open="formDrawer"
    :title="mode === 'create_category' ? 'Nueva familia' : `Editar «${baseline?.name ?? ''}»`"
    :description="
      mode === 'create_category'
        ? 'Se guarda como borrador: no se ve en la tienda hasta que la publiques.'
        : 'Cambia el nombre o muévela dentro de otra familia.'
    "
  >
    <div class="adm-stack min-w-0">
      <div v-if="message" role="status" aria-live="polite">
        <UAlert :color="uncertain || blocked ? 'warning' : 'neutral'" variant="subtle" :title="message" />
      </div>
      <form
        v-if="mode && mode !== 'delete_category' && writable && categoryView"
        :id="`${prefix}-form`"
        :aria-busy="busy"
        @submit.prevent="submit"
      >
        <fieldset
          :disabled="busy || reloading || uncertain || blocked || !permitted(mode, baseline)"
          class="adm-stack min-w-0"
        >
          <div class="adm-field">
            <label :for="`${prefix}-name`" class="adm-label">Nombre</label>
            <input
              :id="`${prefix}-name`"
              v-model="name"
              data-category-name
              required
              minlength="2"
              maxlength="160"
              placeholder="Por ejemplo: desengrasantes"
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
      </form>
    </div>
    <template #footer>
      <template v-if="uncertain || blocked">
        <button
          v-if="uncertain"
          type="button"
          data-category-retry
          class="adm-btn adm-btn--secondary"
          :disabled="!canRetry"
          @click="retry"
        >
          Reintentar el cambio
        </button>
        <button
          type="button"
          data-category-read
          class="adm-btn adm-btn--secondary"
          :disabled="runtime !== 'cloudflare' || busy || reloading || !authorized()"
          @click="reload"
        >
          <UIcon
            :name="reloading ? 'i-lucide-loader-circle' : 'i-lucide-refresh-cw'"
            class="size-4 shrink-0"
            :class="reloading && 'animate-spin'"
          />Actualizar
        </button>
      </template>
      <template v-else>
        <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy" @click="cancel">Cancelar</button>
        <button
          type="submit"
          :form="`${prefix}-form`"
          data-category-submit
          class="adm-btn adm-btn--primary"
          :disabled="!canSubmit || busy"
        >
          <UIcon v-if="busy" name="i-lucide-loader-circle" class="size-4 animate-spin" />
          {{ mode === 'create_category' ? 'Crear familia' : 'Guardar cambios' }}
        </button>
      </template>
    </template>
  </AdminDrawer>

  <AdminConfirm
    v-model:open="retireConfirm"
    title="Retirar familia"
    :description="`«${baseline?.name ?? ''}» dejará de aparecer en la tienda. Su historial y sus direcciones anteriores se conservan.`"
    confirm-label="Retirar familia"
    danger
    :loading="busy"
    :confirm-disabled="busy || reloading || uncertain || blocked || reason.trim().length < 3"
    @confirm="confirmRetire"
  >
    <div class="adm-field">
      <label :for="`${prefix}-retire-reason`" class="adm-label">Motivo de la retirada</label>
      <textarea
        :id="`${prefix}-retire-reason`"
        v-model="reason"
        data-category-reason
        required
        minlength="3"
        maxlength="500"
        rows="2"
        :disabled="busy || reloading || uncertain || blocked"
        class="adm-input w-full"
      />
      <p class="adm-help">Queda guardado en el historial de cambios.</p>
      <p v-if="message" class="adm-field__error" role="alert">{{ message }}</p>
    </div>
  </AdminConfirm>
</template>
