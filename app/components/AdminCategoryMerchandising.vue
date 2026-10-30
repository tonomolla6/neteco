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
  <section class="mx-auto w-full min-w-0 max-w-5xl space-y-6 px-4 py-6" aria-labelledby="cm-title">
    <h2 id="cm-title" class="text-xl font-semibold">Orden de categoría por reglas</h2>
    <p class="text-sm">
      Combina stock, margen, popularidad, contrato y campaña. Los productos sin stock van siempre al final y las
      salvaguardas impiden priorizar por debajo de tus mínimos. Previsualiza antes de guardar.
    </p>
    <p v-if="runtime !== 'cloudflare'" role="status">Esta función requiere el catálogo Cloudflare.</p>
    <p v-else-if="!allowed" role="status">Inicia sesión con una cuenta de administración verificada.</p>
    <template v-else>
      <p v-if="loading" data-cm-loading role="status">Cargando…</p>
      <div v-if="loadError" data-cm-error role="alert" class="space-y-2">
        <p>{{ loadError }}</p>
        <button type="button" data-cm-retry class="rounded border px-3 py-1" @click="load">Reintentar</button>
      </div>
      <template v-else>
        <form class="space-y-4 rounded border p-4" aria-label="Editor de regla" @submit.prevent="runPreview">
          <p v-if="editing" class="font-medium">Editando la versión {{ editing.version }} de la regla</p>
          <label class="block"
            >Categoría
            <select v-model="categoryId" data-cm-category class="ml-2 rounded border p-1" :disabled="editing !== null">
              <option value="">Elige una categoría</option>
              <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select></label
          >
          <fieldset class="grid gap-2 sm:grid-cols-5">
            <legend class="font-medium">Peso de cada señal (0 a 10)</legend>
            <label v-for="s in signals" :key="s" class="block"
              >{{ signalLabels[s] }}
              <input
                v-model.number="weights[s]"
                v-bind="{ [`data-cm-w-${s}`]: '' }"
                type="number"
                min="0"
                max="10"
                step="1"
                class="block w-full rounded border p-1"
            /></label>
          </fieldset>
          <fieldset class="grid gap-2 sm:grid-cols-3">
            <legend class="font-medium">Salvaguardas</legend>
            <label class="block"
              >Stock mínimo para priorizar
              <input
                v-model.number="minStock"
                data-cm-min-stock
                type="number"
                min="0"
                step="1"
                class="block w-full rounded border p-1"
            /></label>
            <label class="block"
              >Margen mínimo (%), vacío = sin suelo
              <input
                v-model="minMarginPercent"
                data-cm-min-margin
                type="number"
                min="0"
                max="100"
                step="0.1"
                class="block w-full rounded border p-1"
            /></label>
            <label class="block"
              >Máximo de productos priorizados
              <input
                v-model.number="maxBoosted"
                data-cm-max-boosted
                type="number"
                min="1"
                max="50"
                step="1"
                class="block w-full rounded border p-1"
            /></label>
          </fieldset>
          <fieldset class="grid gap-2 sm:grid-cols-2">
            <legend class="font-medium">Campaña (opcional)</legend>
            <label class="block"
              >Identificador de campaña comercial
              <input v-model="campaignId" data-cm-campaign-id class="block w-full rounded border p-1 font-mono"
            /></label>
            <label class="block"
              >Productos de campaña (un UUID por línea)
              <textarea
                v-model="campaignProducts"
                data-cm-campaign-products
                rows="3"
                class="block w-full rounded border p-1 font-mono"
              />
            </label>
          </fieldset>
          <label class="block"
            >Vigencia en días (1 a 180)
            <input
              v-model.number="days"
              data-cm-days
              type="number"
              min="1"
              max="180"
              step="1"
              class="ml-2 w-24 rounded border p-1"
          /></label>
          <label class="block"
            >Motivo (obligatorio para guardar)
            <input v-model="reason" data-cm-reason maxlength="500" class="block w-full rounded border p-1"
          /></label>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              data-cm-preview
              class="rounded border px-4 py-2"
              :disabled="!canPreview"
              @click="runPreview"
            >
              Previsualizar orden
            </button>
            <button type="button" data-cm-save class="rounded border px-4 py-2" :disabled="!canSave" @click="save">
              Guardar regla
            </button>
            <button v-if="editing" type="button" class="rounded border px-4 py-2" @click="resetForm">
              Cancelar edición
            </button>
          </div>
        </form>
        <p v-if="notice" data-cm-notice role="status">{{ notice }}</p>
        <p v-if="actionError" data-cm-error role="alert" class="break-words">{{ actionError }}</p>

        <section v-if="preview" aria-label="Previsualización del orden">
          <h3 class="font-medium">Orden resultante</h3>
          <p v-if="preview.truncated" class="text-sm">
            La categoría supera 500 productos: solo se evalúan los primeros.
          </p>
          <ol class="space-y-2">
            <li
              v-for="item in preview.items"
              :key="item.productId"
              data-cm-result
              class="min-w-0 break-words rounded border p-3"
            >
              <p class="font-medium">{{ item.position }}. {{ item.name }} — {{ groupLabels[item.group] }}</p>
              <p class="text-sm">
                Puntuación {{ number(item.score) }} · antes en la posición {{ item.baselineRank }} · stock
                {{ item.sellableStock }} · margen
                {{ item.marginBps === null ? 'desconocido' : number(item.marginBps / 100) + ' %' }} ·
                {{ item.units30d }} uds. en 30 días
              </p>
              <p v-for="g in item.guardrails" :key="g" class="text-sm">{{ guardrailLabels[g] ?? g }}</p>
            </li>
          </ol>
        </section>

        <section aria-label="Reglas">
          <h3 class="font-medium">Reglas activas y programadas</h3>
          <p v-if="!loading && !rules.length" data-cm-empty>No hay reglas. Crea la primera con el editor.</p>
          <ul v-else class="space-y-3">
            <li
              v-for="rule in rules"
              :key="rule.id"
              :data-cm-rule="rule.id"
              class="min-w-0 break-words rounded border p-4"
            >
              <p class="font-medium">
                {{ categoryName(rule.categoryId) }} · {{ stateLabels[rule.state] }} · versión {{ rule.version }}
              </p>
              <p class="text-sm">{{ rule.reason }}</p>
              <p class="text-sm">
                <template v-for="s in signals" :key="s"
                  ><span v-if="rule.weights[s] > 0">{{ signalLabels[s] }} {{ rule.weights[s] }} · </span></template
                >
                hasta {{ rule.validUntil.slice(0, 10) }}
              </p>
              <div class="mt-2 flex gap-2">
                <button
                  type="button"
                  :data-cm-edit="rule.id"
                  class="rounded border px-3 py-1"
                  :disabled="busy"
                  @click="edit(rule)"
                >
                  Editar
                </button>
                <button
                  type="button"
                  :data-cm-retire="rule.id"
                  class="rounded border px-3 py-1"
                  :disabled="busy"
                  @click="retiring = rule"
                >
                  Retirar
                </button>
              </div>
              <div v-if="retiring?.id === rule.id" class="mt-3 space-y-2">
                <label class="block"
                  >Motivo de la retirada
                  <input
                    v-model="retireReason"
                    data-cm-retire-reason
                    maxlength="500"
                    class="block w-full rounded border p-1"
                /></label>
                <button
                  type="button"
                  data-cm-retire-confirm
                  class="rounded border px-3 py-1"
                  :disabled="busy || retireReason.trim().length < 3"
                  @click="retire"
                >
                  Confirmar retirada
                </button>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </template>
  </section>
</template>
