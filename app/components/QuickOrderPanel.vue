<script setup lang="ts">
import { z } from 'zod'
import { useCartStore } from '~/stores/cart'
import {
  QUICK_ORDER_LIST_MAX_ROWS,
  parseQuickOrderList,
  priceQuickOrderLine,
  quickOrderQuantityRules,
  resolveQuickOrderReference,
  type QuickOrderInput,
  type QuickOrderListProblem,
  type QuickOrderSuggestion,
  type QuickOrderVariant
} from '~~/shared/quick-order'
import { SHOP_PHONE, SHOP_PHONE_HREF } from '~~/shared/commercial-terms'

/**
 * Pedido rápido por referencia: una pantalla, una tarea, tres maneras de entrar.
 *
 * Quien repone tiene el albarán delante y reconoce el código antes que el nombre. Teclea la
 * referencia y pulsa Intro, pega la lista entera o sube un archivo; cada fila resuelve su
 * producto y su precio contra el catálogo público (búsqueda y ficha), así que funciona igual
 * en cualquier entorno. Una referencia que no existe se marca y no bloquea a las demás.
 *
 * Las adiciones pasan una a una por el carrito, que es el dueño de su recuperación: si una
 * queda con resultado incierto se para ahí y esa referencia no se reenvía desde aquí.
 */
interface Line {
  key: number
  reference: string
  quantity: number
  state: 'empty' | 'checking' | 'found' | 'error' | 'added' | 'uncertain'
  resolved: string
  name?: string
  slug?: string
  variant?: QuickOrderVariant
  message?: string
  suggestion?: QuickOrderSuggestion
}

const runtime = useRuntimeConfig().public.serverRuntime
const { ready, loggedIn, user, session } = useUserSession()
const request = useRequestFetch()
const cart = useCartStore()
const { net } = usePriceDisplay()

let nextKey = 0
const blank = (): Line => ({ key: nextKey++, reference: '', quantity: 1, state: 'empty', resolved: '' })
const lines = ref<Line[]>([blank()])
const tab = ref<'type' | 'paste' | 'file'>('type')
const pasted = ref('')
const problems = ref<QuickOrderListProblem[]>([])
const fileError = ref('')
const notice = ref('')
const adding = ref(false)
let cache = { searches: new Map(), details: new Map() }
let generation = 0
let disposed = false

const scope = computed(() =>
  JSON.stringify([
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.email,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
/**
 * El carrito del entorno Cloudflare exige, con sesión iniciada, una identidad verificada.
 * Sin sesión se compra como invitado en cualquier entorno.
 */
const allowed = computed(() => {
  if (!ready.value) return false
  if (runtime !== 'cloudflare' || !loggedIn.value) return runtime !== 'cloudflare' || !user.value?.id
  return (
    user.value?.emailVerified === true &&
    z.string().uuid().safeParse(user.value.id).success &&
    z.string().uuid().safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    Number(session.value?.sessionVersion) >= 1
  )
})

function purge() {
  generation++
  cache = { searches: new Map(), details: new Map() }
  lines.value = [blank()]
  pasted.value = ''
  problems.value = []
  fileError.value = ''
  notice.value = ''
  adding.value = false
  tab.value = 'type'
}
watch([scope, allowed], purge, { flush: 'sync' })
onBeforeUnmount(() => {
  disposed = true
  generation++
})
const current = (epoch: number) => !disposed && epoch === generation && allowed.value

const read = async (path: string, options: object) => request(path, options)

function reset(line: Line) {
  Object.assign(line, {
    state: 'empty',
    resolved: '',
    name: undefined,
    slug: undefined,
    variant: undefined,
    message: undefined,
    suggestion: undefined
  })
}
function fail(line: Line, message: string, suggestion?: QuickOrderSuggestion) {
  reset(line)
  Object.assign(line, { state: 'error', resolved: line.reference.trim(), message, suggestion })
}
function ensureBlankRow() {
  if (lines.value.length < QUICK_ORDER_LIST_MAX_ROWS && lines.value.at(-1)?.state !== 'empty') lines.value.push(blank())
}

async function resolve(line: Line, options: { focus?: boolean } = {}) {
  const reference = line.reference.trim()
  if (!reference) return reset(line)
  if (line.state === 'checking' || line.state === 'added' || line.state === 'uncertain') return
  if (reference === line.resolved && line.state !== 'empty') return
  const epoch = generation
  reset(line)
  line.state = 'checking'
  line.resolved = reference
  const result = await resolveQuickOrderReference(reference, read as never, cache)
  if (!current(epoch) || !lines.value.includes(line) || line.reference.trim() !== reference) return
  if (result.status === 'error') return fail(line, result.message, result.suggestion)
  if (lines.value.some((other) => other !== line && other.variant?.id === result.variant.id))
    return fail(line, 'Esta referencia ya está en la lista.')
  const rules = quickOrderQuantityRules(result.variant)
  if (rules.maximumQuantity < rules.minimumQuantity)
    return fail(line, 'Ahora mismo no tenemos existencias de esta referencia.')
  // La cantidad tecleada se lleva a la cantidad válida más cercana de esta variante.
  const steps = Math.max(0, Math.round((line.quantity - rules.minimumQuantity) / rules.quantityIncrement))
  const reachable = Math.floor((rules.maximumQuantity - rules.minimumQuantity) / rules.quantityIncrement)
  line.quantity = rules.minimumQuantity + Math.min(steps, reachable) * rules.quantityIncrement
  Object.assign(line, { state: 'found', name: result.name, slug: result.slug, variant: result.variant })
  ensureBlankRow()
  if (options.focus) await nextTick(() => steppers.get(line.key)?.focus())
}

const steppers = new Map<number, { focus: () => void }>()
const references = new Map<number, HTMLInputElement>()
function focusNext(line: Line) {
  ensureBlankRow()
  const next = lines.value[lines.value.indexOf(line) + 1]
  if (next) nextTick(() => references.get(next.key)?.focus())
}
function remove(line: Line) {
  lines.value = lines.value.filter((other) => other !== line)
  steppers.delete(line.key)
  references.delete(line.key)
  if (!lines.value.length || lines.value.at(-1)?.state !== 'empty') lines.value.push(blank())
}
function useSuggestion(line: Line) {
  if (!line.suggestion) return
  line.reference = line.suggestion.reference
  void resolve(line, { focus: true })
}

async function load(rows: QuickOrderInput[]) {
  const epoch = generation
  const kept = lines.value.filter((line) => line.state !== 'empty')
  const room = Math.max(0, QUICK_ORDER_LIST_MAX_ROWS - kept.length)
  const added = rows.slice(0, room).map((row) => ({ ...blank(), reference: row.reference, quantity: row.quantity }))
  lines.value = [...kept, ...added]
  ensureBlankRow()
  tab.value = 'type'
  // De una en una: cada fila comparte la caché de lecturas y el orden de la lista se conserva.
  for (const line of lines.value.filter((candidate) => added.some((entry) => entry.key === candidate.key))) {
    if (!current(epoch)) return
    await resolve(line)
  }
}
async function applyList(text: string) {
  const parsed = parseQuickOrderList(text)
  problems.value = parsed.problems
  notice.value = ''
  if (parsed.rows.length) await load(parsed.rows)
}
async function applyPaste() {
  await applyList(pasted.value)
  if (!problems.value.length) pasted.value = ''
}
async function readFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  fileError.value = ''
  if (!file) return
  if (file.size > 64 * 1024) {
    fileError.value = 'El archivo es demasiado grande. Usa una lista de hasta 30 referencias.'
    return
  }
  try {
    await applyList(await file.text())
  } catch {
    fileError.value = 'No hemos podido leer el archivo. Guárdalo como texto y vuelve a subirlo.'
  } finally {
    input.value = ''
  }
}
const template = `data:text/csv;charset=utf-8,${encodeURIComponent('referencia;cantidad\r\n')}`

function price(line: Line) {
  if (!line.variant) return null
  try {
    return priceQuickOrderLine(line.variant, line.quantity)
  } catch {
    return null
  }
}
const pending = computed(() => lines.value.filter((line) => line.state === 'found' && price(line)))
const checking = computed(() => lines.value.some((line) => line.state === 'checking'))
const total = computed(() =>
  pending.value.reduce(
    (sum, line) => {
      const amount = price(line)!
      return { net: sum.net + amount.netCents, gross: sum.gross + amount.grossCents }
    },
    { net: 0, gross: 0 }
  )
)
const count = (amount: number, one: string, many: string) => `${amount} ${amount === 1 ? one : many}`

async function addAll() {
  if (!allowed.value || adding.value || checking.value || !pending.value.length) return
  if (cart.pendingMutation || cart.blockedMutations) {
    notice.value = 'Revisa primero el carrito: hay una adición pendiente de comprobar.'
    return
  }
  const epoch = generation
  const batch = [...pending.value]
  adding.value = true
  notice.value = ''
  let added = 0
  const summary = () => (added ? `${count(added, 'referencia añadida', 'referencias añadidas')} al carrito. ` : '')
  try {
    for (const line of batch) {
      if (!current(epoch)) return
      if (cart.pendingMutation || cart.blockedMutations) {
        notice.value = `${summary()}Revisa primero el carrito antes de añadir el resto.`
        return
      }
      const variant = line.variant!
      try {
        await cart.add(
          {
            variantId: variant.id,
            slug: line.slug!,
            name: line.name!,
            sku: variant.sku,
            format: variant.format,
            minimumQuantity: variant.minimumQuantity,
            maximumQuantity: variant.maximumQuantity,
            quantityIncrement: variant.quantityIncrement
          },
          line.quantity
        )
        if (!current(epoch)) return
        line.state = 'added'
        added++
      } catch {
        if (!current(epoch)) return
        line.state = 'uncertain'
        notice.value = `${summary()}No sabemos si la referencia ${variant.sku} se añadió. Compruébala en el carrito antes de seguir.`
        return
      }
    }
    notice.value = `${summary()}Revisa allí las cantidades antes de tramitar el pedido.`
  } finally {
    if (current(epoch)) adding.value = false
  }
}
</script>

<template>
  <section class="mx-auto w-full min-w-0 max-w-5xl px-4 py-8" aria-labelledby="quick-title">
    <h1 id="quick-title" class="text-2xl font-bold text-[var(--text-strong)] sm:text-3xl">
      Pedido rápido por referencia
    </h1>
    <p class="mt-2 text-[var(--text-muted)]">Escribe las referencias de tu albarán o pega la lista entera.</p>

    <p
      v-if="!allowed"
      role="status"
      class="mt-6 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4"
    >
      <template v-if="!ready">Estamos comprobando tu sesión…</template>
      <template v-else>
        Verifica el correo de tu cuenta para usar el pedido rápido. Mientras tanto puedes buscar la referencia en el
        buscador o llamarnos al <a :href="SHOP_PHONE_HREF" class="font-semibold underline">{{ SHOP_PHONE }}</a
        >.
      </template>
    </p>

    <div v-else class="mt-6 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)]">
      <div
        role="tablist"
        aria-label="Cómo quieres indicar las referencias"
        class="flex border-b border-[var(--border)]"
      >
        <button
          v-for="option in [
            { id: 'type', label: 'Teclear' },
            { id: 'paste', label: 'Pegar lista' },
            { id: 'file', label: 'Subir archivo' }
          ] as const"
          :id="`quick-tab-${option.id}`"
          :key="option.id"
          type="button"
          role="tab"
          :data-quick-tab="option.id"
          :aria-selected="tab === option.id"
          :aria-controls="`quick-panel-${option.id}`"
          class="-mb-px min-h-11 border-b-2 px-4 text-[15px] font-semibold transition-colors"
          :class="
            tab === option.id
              ? 'border-[var(--action)] text-[var(--action)]'
              : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-strong)]'
          "
          @click="tab = option.id"
        >
          {{ option.label }}
        </button>
      </div>

      <div v-if="tab === 'paste'" id="quick-panel-paste" role="tabpanel" aria-labelledby="quick-tab-paste" class="p-4">
        <label for="quick-paste" class="block font-semibold text-[var(--text-strong)]">Lista de referencias</label>
        <p id="quick-paste-help" class="mt-1 text-[13px] text-[var(--text-muted)]">
          Una línea por producto: la referencia y la cantidad, separadas por un espacio, un tabulador, una coma o un
          punto y coma. Puedes copiarla tal cual de una hoja de cálculo o de un correo. Hasta
          {{ QUICK_ORDER_LIST_MAX_ROWS }} referencias.
        </p>
        <textarea
          id="quick-paste"
          v-model="pasted"
          data-quick-paste
          rows="8"
          aria-describedby="quick-paste-help"
          placeholder="1042 2&#10;1133 4&#10;990 1"
          class="tabular mt-3 block w-full min-w-0 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] p-3"
        />
        <UButton data-quick-paste-apply class="mt-3" size="lg" :disabled="!pasted.trim()" @click="applyPaste">
          Pasar a la tabla
        </UButton>
      </div>

      <div
        v-else-if="tab === 'file'"
        id="quick-panel-file"
        role="tabpanel"
        aria-labelledby="quick-tab-file"
        class="p-4"
      >
        <label for="quick-file" class="block font-semibold text-[var(--text-strong)]">Archivo con tu pedido</label>
        <p id="quick-file-help" class="mt-1 text-[13px] text-[var(--text-muted)]">
          Un archivo de texto con dos columnas, referencia y cantidad, como el que exporta tu hoja de cálculo. Hasta
          {{ QUICK_ORDER_LIST_MAX_ROWS }} referencias.
        </p>
        <input
          id="quick-file"
          data-quick-file
          type="file"
          accept=".csv,.txt,.tsv,text/csv,text/plain"
          aria-describedby="quick-file-help"
          class="mt-3 block w-full min-w-0 text-[15px] file:mr-3 file:min-h-11 file:rounded-[var(--radius-control)] file:border file:border-solid file:border-[var(--border-strong)] file:bg-[var(--surface)] file:px-4 file:font-semibold"
          @change="readFile"
        />
        <p v-if="fileError" role="alert" class="mt-2 text-[13px] text-[var(--ui-error)]">{{ fileError }}</p>
        <a
          :href="template"
          download="pedido-rapido.csv"
          data-quick-template
          class="mt-3 inline-block text-[15px] font-medium text-[var(--link)] underline"
        >
          Descargar plantilla
        </a>
      </div>

      <div v-else id="quick-panel-type" role="tabpanel" aria-labelledby="quick-tab-type">
        <div
          aria-hidden="true"
          class="hidden grid-cols-[9rem_minmax(0,1fr)_9.5rem_6rem_6.5rem_2.75rem] gap-3 border-b border-[var(--border)] px-4 py-2 text-[13px] font-medium text-[var(--text-muted)] md:grid"
        >
          <span>Referencia</span><span>Producto</span><span>Cantidad</span><span class="text-right">Precio</span
          ><span class="text-right">Importe</span><span />
        </div>
        <ul class="divide-y divide-[var(--border)]">
          <li
            v-for="(line, index) in lines"
            :key="line.key"
            data-quick-row
            class="grid grid-cols-[minmax(0,1fr)_2.75rem] items-center gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[9rem_minmax(0,1fr)_9.5rem_6rem_6.5rem_2.75rem]"
          >
            <input
              :ref="
                (element) =>
                  element ? references.set(line.key, element as HTMLInputElement) : references.delete(line.key)
              "
              v-model="line.reference"
              data-quick-reference
              type="text"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              :aria-label="`Referencia, fila ${index + 1}`"
              :disabled="line.state === 'added' || line.state === 'uncertain' || adding"
              placeholder="Referencia"
              class="tabular h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 font-medium text-[var(--text-strong)] disabled:bg-[var(--surface-sunken)]"
              @keydown.enter.prevent="resolve(line, { focus: true })"
              @blur="resolve(line)"
            />
            <button
              v-if="line.state !== 'empty' || line.reference"
              type="button"
              data-quick-remove
              class="order-2 flex size-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text-strong)] md:order-none md:col-start-6"
              :aria-label="`Quitar la fila ${index + 1}`"
              :disabled="adding"
              @click="remove(line)"
            >
              <UIcon name="i-lucide-x" class="size-5" />
            </button>

            <div class="col-span-2 min-w-0 md:col-span-1 md:col-start-2 md:row-start-1">
              <p v-if="line.state === 'empty'" class="text-[13px] text-[var(--text-muted)]">
                Escribe una referencia y pulsa Intro
              </p>
              <p v-else-if="line.state === 'checking'" role="status" class="text-[13px] text-[var(--text-muted)]">
                Buscando la referencia…
              </p>
              <template v-else-if="line.state === 'error'">
                <p role="alert" class="flex items-start gap-1.5 text-[15px] text-[var(--ui-error)]">
                  <UIcon name="i-lucide-circle-alert" class="mt-0.5 size-4 shrink-0" />{{ line.message }}
                </p>
                <p v-if="line.suggestion" class="mt-1 text-[13px] text-[var(--text)]">
                  ¿Es {{ line.suggestion.reference }} · {{ line.suggestion.name }}?
                  <button
                    type="button"
                    data-quick-suggestion
                    class="ml-1 font-semibold text-[var(--link)] underline"
                    @click="useSuggestion(line)"
                  >
                    Usar {{ line.suggestion.reference }}
                  </button>
                </p>
              </template>
              <template v-else>
                <NuxtLink
                  :to="`/producto/${line.slug}`"
                  class="line-clamp-2 text-[15px] font-semibold leading-snug text-[var(--text-strong)] hover:underline"
                >
                  {{ line.name }}
                </NuxtLink>
                <p class="text-[13px] text-[var(--text-muted)]">{{ line.variant!.format }}</p>
                <p
                  v-if="line.state === 'added'"
                  class="mt-0.5 flex items-center gap-1 text-[13px] font-medium text-[var(--stock-ok)]"
                >
                  <UIcon name="i-lucide-check" class="size-3.5" /> En el carrito
                </p>
                <p
                  v-else-if="line.state === 'uncertain'"
                  class="mt-0.5 text-[13px] font-medium text-[var(--stock-low)]"
                >
                  Compruébala en el carrito: no sabemos si se añadió.
                </p>
              </template>
            </div>

            <template v-if="line.variant">
              <QuantityStepper
                :ref="
                  (component) => (component ? steppers.set(line.key, component as never) : steppers.delete(line.key))
                "
                v-model="line.quantity"
                class="md:col-start-3 md:row-start-1"
                :minimum="quickOrderQuantityRules(line.variant).minimumQuantity"
                :maximum="quickOrderQuantityRules(line.variant).maximumQuantity"
                :step="line.variant.quantityIncrement"
                :label="line.name"
                :disabled="line.state !== 'found' || adding"
                @enter="focusNext(line)"
              />
              <p
                v-if="price(line)"
                class="tabular text-right text-[13px] text-[var(--text-muted)] md:col-start-4 md:row-start-1 md:text-[15px] md:text-[var(--text)]"
              >
                {{ formatPrice(net ? Math.round(price(line)!.netCents / line.quantity) : price(line)!.unitGrossCents) }}
              </p>
              <p
                v-if="price(line)"
                data-quick-line-total
                class="tabular col-span-2 text-right font-semibold text-[var(--text-strong)] md:col-span-1 md:col-start-5 md:row-start-1"
              >
                {{ formatPrice(net ? price(line)!.netCents : price(line)!.grossCents) }}
              </p>
            </template>
          </li>
        </ul>
      </div>

      <ul
        v-if="problems.length"
        data-quick-problems
        class="border-t border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3 text-[13px] text-[var(--text)]"
      >
        <li v-for="problem in problems" :key="problem.line">
          <span class="font-semibold">Línea {{ problem.line }}</span> («{{ problem.text }}»): {{ problem.message }}
        </li>
      </ul>

      <div
        class="flex flex-col gap-3 border-t border-[var(--border)] p-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <p data-quick-total class="tabular text-[15px] text-[var(--text)]">
          <template v-if="pending.length">
            <span class="font-semibold text-[var(--text-strong)]">
              {{ count(pending.length, 'referencia', 'referencias') }} ·
              {{ formatPrice(net ? total.net : total.gross) }}
            </span>
            {{ net ? 'sin IVA' : 'IVA incluido' }}
            <span class="text-[13px] text-[var(--text-muted)]">
              · {{ formatPrice(net ? total.gross : total.net) }} {{ net ? 'con IVA' : 'sin IVA' }}
            </span>
          </template>
          <template v-else>Todavía no hay referencias que añadir.</template>
        </p>
        <button
          type="button"
          data-quick-add
          :disabled="!pending.length || adding || checking"
          class="inline-flex h-12 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--action)] px-6 font-semibold text-white transition-colors hover:bg-[var(--action-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          @click="addAll"
        >
          {{ adding ? 'Añadiendo…' : 'Añadir todo al carrito' }}
        </button>
      </div>
      <div aria-live="polite">
        <p
          v-if="notice"
          data-quick-notice
          class="border-t border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3 text-[15px] text-[var(--text)]"
        >
          {{ notice }}
          <NuxtLink to="/carrito" class="ml-1 font-semibold text-[var(--link)] underline">Ir al carrito</NuxtLink>
        </p>
      </div>
    </div>

    <p class="mt-4 text-[13px] text-[var(--text-muted)]">
      Los precios son los de hoy en el catálogo; el carrito los confirma junto con el envío. ¿No encuentras una
      referencia? Llámanos al
      <a :href="SHOP_PHONE_HREF" class="font-medium underline">{{ SHOP_PHONE }}</a
      >.
    </p>
  </section>
</template>
