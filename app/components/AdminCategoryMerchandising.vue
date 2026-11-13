<script setup lang="ts">
import { z } from 'zod'

// SEA-015. Category merchandising by rule: tune the five signals and the guardrails, preview the
// resulting order against the real catalogue, then save a versioned, audited rule. The server is the
// only authority; this panel validates for convenience and never sends identity or company.
const runtime = useRuntimeConfig().public.serverRuntime
const { ready, loggedIn, user, session } = useUserSession()
const request = useRequestFetch()
const BASE = '/api/admin/category-merchandising'

const uuid = z.string().uuid()
const categorySchema = z.object({ id: uuid, name: z.string(), slug: z.string(), parentId: uuid.nullable() })
const ruleSchema = z.object({
  id: uuid,
  categoryId: uuid,
  weights: z.object({
    stock: z.number(),
    margin: z.number(),
    popularity: z.number(),
    contract: z.number(),
    campaign: z.number()
  }),
  guardrails: z.object({ minStock: z.number(), minMarginBps: z.number().nullable(), maxBoosted: z.number() }),
  campaign: z.object({ campaignId: uuid.nullable(), productIds: z.array(uuid) }),
  reason: z.string(),
  validFrom: z.string(),
  validUntil: z.string(),
  status: z.enum(['active', 'retired']),
  version: z.number().int(),
  state: z.enum(['live', 'scheduled', 'expired', 'retired'])
})
const listSchema = z.object({ items: z.array(ruleSchema).max(100) })
const previewSchema = z.object({
  truncated: z.boolean(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        name: z.string(),
        position: z.number(),
        baselineRank: z.number(),
        score: z.number(),
        group: z.enum(['boosted', 'neutral', 'demoted']),
        guardrails: z.array(z.string()),
        sellableStock: z.number(),
        marginBps: z.number().nullable(),
        units30d: z.number()
      })
    )
    .max(500)
})
type Category = z.infer<typeof categorySchema>
type Rule = z.infer<typeof ruleSchema>
type Preview = z.infer<typeof previewSchema>

const signals = ['stock', 'margin', 'popularity', 'contract', 'campaign'] as const
const signalLabels = {
  stock: 'Stock',
  margin: 'Margen',
  popularity: 'Popularidad',
  contract: 'Contrato',
  campaign: 'Campaña'
} as const
const categories = shallowRef<Category[]>([])
const rules = shallowRef<Rule[]>([])
const loading = ref(false)
const loadError = ref('')
const actionError = ref('')
const notice = ref('')
const busy = ref(false)
const preview = shallowRef<Preview | null>(null)

const categoryId = ref('')
const weights = reactive({ stock: 0, margin: 0, popularity: 0, contract: 0, campaign: 0 })
const minStock = ref(0)
const minMarginPercent = ref<string | number>('')
const maxBoosted = ref(6)
const campaignId = ref('')
const campaignProducts = ref('')
const days = ref(30)
const reason = ref('')
const editing = ref<{ id: string; version: number } | null>(null)
const retiring = ref<Rule | null>(null)
const retireReason = ref('')
let generation = 0 // bumped only when the session scope changes
let loadSeq = 0 // bumped by every list reload
let disposed = false

const scope = computed(() =>
  JSON.stringify([ready.value, loggedIn.value, user.value?.id, session.value?.sessionId, session.value?.sessionVersion])
)
const allowed = computed(
  () => runtime === 'cloudflare' && ready.value && loggedIn.value && user.value?.emailVerified === true
)
const productIds = computed(() => campaignProducts.value.split(/[\s,;]+/).filter(Boolean))
const marginBps = computed(() =>
  String(minMarginPercent.value ?? '').trim() === '' ? null : Math.round(Number(minMarginPercent.value) * 100)
)
const draftValid = computed(
  () =>
    uuid.safeParse(categoryId.value).success &&
    signals.every((s) => Number.isInteger(weights[s]) && weights[s] >= 0 && weights[s] <= 10) &&
    signals.some((s) => weights[s] > 0) &&
    Number.isInteger(minStock.value) &&
    minStock.value >= 0 &&
    Number.isInteger(maxBoosted.value) &&
    maxBoosted.value >= 1 &&
    maxBoosted.value <= 50 &&
    (marginBps.value === null ||
      (Number.isInteger(marginBps.value) && marginBps.value >= 0 && marginBps.value <= 10000)) &&
    productIds.value.every((id) => uuid.safeParse(id).success) &&
    new Set(productIds.value).size === productIds.value.length &&
    (campaignId.value === '' || uuid.safeParse(campaignId.value).success) &&
    (weights.campaign === 0 || productIds.value.length > 0)
)
const canPreview = computed(() => allowed.value && !busy.value && draftValid.value)
const canSave = computed(
  () =>
    canPreview.value &&
    reason.value.trim().length >= 3 &&
    Number.isInteger(days.value) &&
    days.value >= 1 &&
    days.value <= 180
)
const draftContent = () => ({
  weights: { ...weights },
  guardrails: { minStock: minStock.value, minMarginBps: marginBps.value, maxBoosted: maxBoosted.value },
  campaign: { campaignId: campaignId.value === '' ? null : campaignId.value, productIds: productIds.value }
})
const categoryName = (id: string) => categories.value.find((c) => c.id === id)?.name ?? 'Categoría'

const groupLabels = { boosted: 'Priorizado', neutral: 'Orden habitual', demoted: 'Al final' } as const
const guardrailLabels: Record<string, string> = {
  out_of_stock: 'Sin stock: se coloca al final',
  below_min_stock: 'Stock bajo el mínimo: no se prioriza',
  margin_floor: 'Margen bajo el suelo: no se prioriza',
  margin_unknown: 'Margen desconocido: no se prioriza',
  boost_cap: 'Fuera del límite de priorizados'
}
const stateLabels = { live: 'En vigor', scheduled: 'Programada', expired: 'Caducada', retired: 'Retirada' } as const
function describe(failure: unknown) {
  const code = (failure as { data?: { error?: { code?: string } } })?.data?.error?.code
  const messages: Record<string, string> = {
    forbidden: 'No tienes permiso para gestionar el orden de categorías.',
    mfa_required: 'Verifica el segundo factor para continuar.',
    unauthenticated: 'Tu sesión ha caducado.',
    version_conflict: 'La regla cambió mientras la editabas; se ha recargado.',
    rule_conflict: 'Esa categoría ya tiene una regla activa en ese periodo. Retírala o cambia las fechas.',
    category_unavailable: 'La categoría no está publicada.',
    product_unavailable: 'Algún producto de campaña no existe o no está publicado.',
    campaign_unavailable: 'La campaña indicada no existe.',
    expiry_invalid: 'La caducidad debe ser futura.',
    idempotency_conflict: 'Esa operación ya se envió con otros datos. Recarga la página.',
    rate_limited: 'Demasiadas acciones seguidas. Espera un momento.',
    invalid_input: 'Revisa los datos: pesos de 0 a 10 y al menos uno positivo.'
  }
  return (code && messages[code]) || 'No se pudo completar la operación. Inténtalo de nuevo.'
}
const idempotencyKey = () => `cm-${crypto.randomUUID()}`

async function load() {
  if (!allowed.value) return
  const epoch = generation
  const seq = ++loadSeq
  loading.value = true
  loadError.value = ''
  try {
    const [cats, list] = await Promise.all([
      request(`${BASE}/categories`, { cache: 'no-store', retry: 0 }),
      request(BASE, { query: { status: 'open', perPage: 100 }, cache: 'no-store', retry: 0 })
    ])
    if (disposed || epoch !== generation || seq !== loadSeq) return
    categories.value = z.object({ items: z.array(categorySchema) }).parse(cats).items
    rules.value = listSchema.parse(list).items
  } catch (failure) {
    if (!disposed && epoch === generation && seq === loadSeq) {
      categories.value = []
      rules.value = []
      loadError.value = failure instanceof z.ZodError ? 'Respuesta no válida del servidor.' : describe(failure)
    }
  } finally {
    if (epoch === generation && seq === loadSeq) loading.value = false
  }
}
async function runPreview() {
  if (!canPreview.value) return
  const epoch = generation
  busy.value = true
  actionError.value = ''
  notice.value = ''
  try {
    const value = await request(`${BASE}/preview`, {
      method: 'POST',
      body: { categoryId: categoryId.value, ruleId: null, companyId: null, draft: draftContent() },
      cache: 'no-store',
      retry: 0
    })
    if (!disposed && epoch === generation) preview.value = previewSchema.parse(value)
  } catch (failure) {
    if (!disposed && epoch === generation) actionError.value = describe(failure)
  } finally {
    if (epoch === generation) busy.value = false
  }
}
function resetForm() {
  editing.value = null
  retiring.value = null
  retireReason.value = ''
  reason.value = ''
  preview.value = null
}
async function save() {
  if (!canSave.value) return
  const epoch = generation
  busy.value = true
  actionError.value = ''
  notice.value = ''
  const from = new Date()
  const until = new Date(from.getTime() + days.value * 86_400_000)
  const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const current = editing.value
  try {
    await request(current ? `${BASE}/${current.id}` : BASE, {
      method: current ? 'PUT' : 'POST',
      headers: { 'Idempotency-Key': idempotencyKey() },
      body: {
        action: 'save',
        id: current?.id ?? null,
        expectedVersion: current?.version ?? 0,
        categoryId: categoryId.value,
        ...draftContent(),
        reason: reason.value.trim(),
        validFrom: iso(from),
        validUntil: iso(until)
      },
      cache: 'no-store',
      retry: 0
    })
    if (disposed || epoch !== generation) return
    resetForm()
    await load()
    notice.value = 'Regla guardada.'
  } catch (failure) {
    if (disposed || epoch !== generation) return
    actionError.value = describe(failure)
    if ((failure as { data?: { error?: { code?: string } } })?.data?.error?.code === 'version_conflict') await load()
  } finally {
    if (epoch === generation) busy.value = false
  }
}
function edit(rule: Rule) {
  editing.value = { id: rule.id, version: rule.version }
  categoryId.value = rule.categoryId
  for (const s of signals) weights[s] = rule.weights[s]
  minStock.value = rule.guardrails.minStock
  minMarginPercent.value = rule.guardrails.minMarginBps === null ? '' : String(rule.guardrails.minMarginBps / 100)
  maxBoosted.value = rule.guardrails.maxBoosted
  campaignId.value = rule.campaign.campaignId ?? ''
  campaignProducts.value = rule.campaign.productIds.join('\n')
  reason.value = ''
  preview.value = null
  actionError.value = ''
  notice.value = ''
}
async function retire() {
  const rule = retiring.value
  if (!allowed.value || !rule || busy.value || retireReason.value.trim().length < 3) return
  const epoch = generation
  busy.value = true
  actionError.value = ''
  try {
    await request(`${BASE}/${rule.id}`, {
      method: 'DELETE',
      headers: { 'Idempotency-Key': idempotencyKey() },
      body: { action: 'retire', id: rule.id, expectedVersion: rule.version, reason: retireReason.value.trim() },
      cache: 'no-store',
      retry: 0
    })
    if (disposed || epoch !== generation) return
    resetForm()
    await load()
    notice.value = 'Regla retirada.'
  } catch (failure) {
    if (disposed || epoch !== generation) return
    actionError.value = describe(failure)
    await load()
  } finally {
    if (epoch === generation) busy.value = false
  }
}
function purge() {
  generation++
  categories.value = []
  rules.value = []
  preview.value = null
  loadError.value = ''
  actionError.value = ''
  notice.value = ''
  categoryId.value = ''
  for (const s of signals) weights[s] = 0
  minStock.value = 0
  minMarginPercent.value = ''
  maxBoosted.value = 6
  campaignId.value = ''
  campaignProducts.value = ''
  days.value = 30
  resetForm()
  busy.value = false
  loading.value = false
}
watch(
  scope,
  () => {
    purge()
    void load()
  },
  { flush: 'sync' }
)
onMounted(() => void load())
onBeforeUnmount(() => {
  disposed = true
  purge()
})
const number = (value: number) => value.toLocaleString('es-ES', { maximumFractionDigits: 1 })
</script>

<template>
  <section class="adm-stack" aria-label="Orden de productos por categoría">
    <AdminEmptyState
      v-if="runtime !== 'cloudflare'"
      role="status"
      icon="i-lucide-cloud-off"
      title="Función no disponible en este entorno"
      description="El orden por reglas solo funciona con el catálogo en línea de la tienda."
    />
    <AdminEmptyState
      v-else-if="!allowed"
      role="status"
      icon="i-lucide-lock"
      title="Necesitas una cuenta de administración verificada"
      description="Inicia sesión con una cuenta verificada para gestionar el orden de las categorías."
    />
    <template v-else>
      <p v-if="loading" data-cm-loading role="status" class="adm-help">Cargando…</p>
      <AdminEmptyState
        v-if="loadError"
        data-cm-error
        role="alert"
        variant="error"
        title="No se han podido cargar las reglas"
        :description="loadError"
      >
        <button type="button" data-cm-retry class="adm-btn adm-btn--secondary" @click="load">Reintentar</button>
      </AdminEmptyState>
      <template v-else>
        <UAlert
          v-if="notice"
          data-cm-notice
          role="status"
          color="success"
          variant="subtle"
          icon="i-lucide-circle-check"
          :title="notice"
        />
        <UAlert
          v-if="actionError"
          data-cm-error
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="actionError"
        />

        <div class="grid items-start gap-5 xl:grid-cols-2">
          <AdminCard
            :title="editing ? 'Editar regla' : 'Nueva regla'"
            description="Los productos sin stock van siempre al final. Comprueba el resultado antes de guardar."
          >
            <form class="adm-stack" aria-label="Editor de regla" @submit.prevent="runPreview">
              <AdminFormField v-slot="{ id }" label="Categoría" required>
                <select :id="id" v-model="categoryId" data-cm-category :disabled="editing !== null">
                  <option value="">Elige una categoría</option>
                  <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
              </AdminFormField>
              <fieldset class="adm-field">
                <legend class="adm-label">Importancia de cada criterio (de 0 a 10)</legend>
                <div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <label v-for="s in signals" :key="s" class="adm-field">
                    <span class="adm-help">{{ signalLabels[s] }}</span>
                    <input
                      v-model.number="weights[s]"
                      v-bind="{ [`data-cm-w-${s}`]: '' }"
                      type="number"
                      min="0"
                      max="10"
                      step="1"
                      class="w-full"
                    />
                  </label>
                </div>
              </fieldset>
              <fieldset class="adm-field">
                <legend class="adm-label">Límites</legend>
                <div class="grid gap-3 sm:grid-cols-3">
                  <label class="adm-field">
                    <span class="adm-help">Stock mínimo para destacar</span>
                    <input v-model.number="minStock" data-cm-min-stock type="number" min="0" step="1" class="w-full" />
                  </label>
                  <label class="adm-field">
                    <span class="adm-help">Margen mínimo (%), vacío = sin mínimo</span>
                    <input
                      v-model="minMarginPercent"
                      data-cm-min-margin
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      class="w-full"
                    />
                  </label>
                  <label class="adm-field">
                    <span class="adm-help">Máximo de productos destacados</span>
                    <input
                      v-model.number="maxBoosted"
                      data-cm-max-boosted
                      type="number"
                      min="1"
                      max="50"
                      step="1"
                      class="w-full"
                    />
                  </label>
                </div>
              </fieldset>
              <fieldset class="adm-field">
                <legend class="adm-label">Campaña (opcional)</legend>
                <div class="grid gap-3 sm:grid-cols-2">
                  <label class="adm-field">
                    <span class="adm-help">Identificador de la campaña</span>
                    <input v-model="campaignId" data-cm-campaign-id class="w-full" />
                  </label>
                  <label class="adm-field">
                    <span class="adm-help">Productos de la campaña (un identificador por línea)</span>
                    <textarea v-model="campaignProducts" data-cm-campaign-products rows="3" class="w-full" />
                  </label>
                </div>
              </fieldset>
              <div class="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <AdminFormField v-slot="{ id }" label="Duración en días" help="De 1 a 180.">
                  <input
                    :id="id"
                    v-model.number="days"
                    data-cm-days
                    type="number"
                    min="1"
                    max="180"
                    step="1"
                    class="w-full"
                  />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Motivo" help="Obligatorio para guardar." required>
                  <input :id="id" v-model="reason" data-cm-reason maxlength="500" class="w-full" />
                </AdminFormField>
              </div>
              <div class="flex flex-wrap justify-end gap-2">
                <button v-if="editing" type="button" class="adm-btn adm-btn--ghost" @click="resetForm">
                  Cancelar edición
                </button>
                <button
                  type="button"
                  data-cm-preview
                  class="adm-btn adm-btn--secondary"
                  :disabled="!canPreview"
                  @click="runPreview"
                >
                  Previsualizar orden
                </button>
                <button type="button" data-cm-save class="adm-btn adm-btn--primary" :disabled="!canSave" @click="save">
                  Guardar regla
                </button>
              </div>
            </form>
          </AdminCard>

          <AdminCard
            title="Orden resultante"
            description="Así quedarían los productos de la categoría con esta regla."
            :flush="preview !== null"
          >
            <section v-if="preview" aria-label="Previsualización del orden">
              <p v-if="preview.truncated" class="adm-help px-4 pt-3">
                La categoría tiene más de 500 productos: solo se muestran los primeros.
              </p>
              <ol class="adm-list">
                <li v-for="item in preview.items" :key="item.productId" data-cm-result class="min-w-0 break-words">
                  <span class="adm-list__index">{{ item.position }}</span>
                  <div class="min-w-0 flex-1">
                    <p class="adm-list__title">
                      {{ item.name }}
                      <AdminBadge
                        :tone="item.group === 'boosted' ? 'success' : item.group === 'demoted' ? 'warning' : 'neutral'"
                        plain
                      >
                        {{ groupLabels[item.group] }}
                      </AdminBadge>
                    </p>
                    <p class="adm-help">
                      Puntuación {{ number(item.score) }} · antes en la posición {{ item.baselineRank }} · stock
                      {{ item.sellableStock }} · margen
                      {{ item.marginBps === null ? 'desconocido' : number(item.marginBps / 100) + ' %' }} ·
                      {{ item.units30d }} uds. en 30 días
                    </p>
                    <p v-for="g in item.guardrails" :key="g" class="adm-help">
                      {{ guardrailLabels[g] ?? adminHumanize(g) }}
                    </p>
                  </div>
                </li>
              </ol>
            </section>
            <AdminEmptyState
              v-else
              compact
              icon="i-lucide-list-ordered"
              title="Todavía no hay vista previa"
              description="Elige una categoría, da importancia a algún criterio y pulsa «Previsualizar orden»."
            />
          </AdminCard>
        </div>

        <AdminCard title="Reglas en vigor y programadas" flush>
          <section aria-label="Reglas">
            <div v-if="!loading && !rules.length" data-cm-empty>
              <AdminEmptyState
                compact
                icon="i-lucide-arrow-down-up"
                title="No hay reglas"
                description="Crea la primera con el formulario de arriba."
              />
            </div>
            <div v-else class="adm-table-wrap">
              <table class="adm-table">
                <thead>
                  <tr>
                    <th scope="col">Categoría</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Criterios</th>
                    <th scope="col">Motivo</th>
                    <th scope="col">Vigente hasta</th>
                    <th scope="col"><span class="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="rule in rules" :key="rule.id" :data-cm-rule="rule.id">
                    <td class="font-semibold text-[var(--text-strong)]">{{ categoryName(rule.categoryId) }}</td>
                    <td>
                      <AdminBadge
                        :tone="rule.state === 'live' ? 'success' : rule.state === 'scheduled' ? 'info' : 'neutral'"
                      >
                        {{ stateLabels[rule.state] }}
                      </AdminBadge>
                    </td>
                    <td>
                      <template v-for="s in signals" :key="s">
                        <span v-if="rule.weights[s] > 0" class="adm-chip mr-1">
                          {{ signalLabels[s] }} {{ rule.weights[s] }}
                        </span>
                      </template>
                    </td>
                    <td class="break-words">{{ rule.reason }}</td>
                    <td class="whitespace-nowrap">{{ adminDate(rule.validUntil) }}</td>
                    <td class="adm-table__actions">
                      <button
                        type="button"
                        :data-cm-edit="rule.id"
                        class="adm-btn adm-btn--secondary adm-btn--sm"
                        :disabled="busy"
                        @click="edit(rule)"
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        :data-cm-retire="rule.id"
                        class="adm-btn adm-btn--danger-soft adm-btn--sm"
                        :disabled="busy"
                        @click="retiring = rule"
                      >
                        Retirar
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <template v-if="retiring" #footer>
            <div class="flex w-full flex-wrap items-end gap-3">
              <AdminFormField
                v-slot="{ id }"
                class="min-w-0 flex-1"
                :label="`Motivo para retirar la regla de «${categoryName(retiring.categoryId)}»`"
                required
              >
                <input :id="id" v-model="retireReason" data-cm-retire-reason maxlength="500" class="w-full" />
              </AdminFormField>
              <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy" @click="retiring = null">
                Cancelar
              </button>
              <button
                type="button"
                data-cm-retire-confirm
                class="adm-btn adm-btn--danger"
                :disabled="busy || retireReason.trim().length < 3"
                @click="retire"
              >
                Confirmar retirada
              </button>
            </div>
          </template>
        </AdminCard>
      </template>
    </template>
  </section>
</template>
