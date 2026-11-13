<script setup lang="ts">
import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

const props = defineProps<{
  modelValue: string | number
  definitionId: string
  label: string
  selfId: string
  available: boolean
  authority: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; denied: [] }>()
const request = useRequestFetch(),
  query = ref(''),
  loading = ref(false),
  message = ref(''),
  selectedName = ref('')
const candidate = z.object({
  uuid: catalogPolicyUuidSchema,
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  categoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().min(1).max(500),
  slug: z.string().min(1).max(500),
  brand: z.string().max(500)
})
type Candidate = z.infer<typeof candidate>
const results = shallowRef<Candidate[]>([])
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const adminView = z.object({
  source: z.literal('cloudflare'),
  capabilities: z.object({ productsRead: z.literal(true) }),
  items: z
    .array(
      z.object({
        uuid: z.string().min(1).max(500),
        id: natural,
        name: z.string().min(1).max(500),
        status: z.literal('published')
      })
    )
    .max(1),
  pagination: z.object({ page: z.literal(1), perPage: z.literal(1), total: natural, pages: natural })
})
const publicView = z.object({
  items: z
    .array(candidate)
    .max(20)
    .refine((items) => new Set(items.map((item) => item.uuid)).size === items.length),
  total: natural,
  page: z.literal(1),
  pages: natural
})
let epoch = 0,
  alive = true
function invalidate() {
  epoch++
  results.value = []
  selectedName.value = ''
  loading.value = false
  message.value = ''
}
watch(() => [query.value, props.available, props.authority], invalidate, { flush: 'sync' })
watch(
  () => props.modelValue,
  () => {
    selectedName.value = ''
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  invalidate()
})
const validQuery = computed(() => {
  const text = query.value.trim()
  return (
    text.length >= 2 &&
    text.length <= 100 &&
    !Array.from(text).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  )
})
async function search() {
  if (!props.available || loading.value || !validQuery.value) return
  invalidate()
  const turn = epoch,
    owner = props.authority,
    q = query.value.trim()
  const current = () => alive && turn === epoch && props.available && props.authority === owner
  loading.value = true
  try {
    const settle = (operation: Promise<unknown>) =>
      operation.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
    // The private read checks live catalog.write/MFA. Its rows are NEVER a
    // candidate source: independent page order must not hide public matches.
    const [admin, published] = await Promise.all([
      settle(
        request<unknown>('/api/admin/products', {
          method: 'GET',
          query: { q, status: 'published', page: 1, perPage: 1 },
          cache: 'no-store',
          retry: 0
        })
      ),
      settle(
        request<unknown>('/api/products', {
          method: 'GET',
          query: { q, page: 1, limit: 20 },
          cache: 'no-store',
          retry: 0
        })
      )
    ])
    // Wait for both reads so a public transport error cannot conceal a later
    // authoritative private denial. No automatic request retries.
    if (!admin.ok) throw admin.error
    if (!current()) return
    adminView.parse(catalogPolicyOwnJson(admin.value))
    if (!published.ok) throw published.error
    const parsed = publicView.parse(catalogPolicyOwnJson(published.value))
    results.value = parsed.items.filter((item) => item.uuid !== props.selfId)
    message.value = results.value.length
      ? 'Se muestran hasta 20 productos. Si no ves el que buscas, escribe algo más concreto.'
      : 'No hay ningún producto publicado que coincida.'
  } catch (error) {
    const status =
      error && typeof error === 'object'
        ? (Reflect.get(error, 'statusCode') ?? Reflect.get(error, 'status'))
        : undefined
    if ((status === 401 || status === 403) && alive && props.authority === owner) emit('denied')
    else if (current()) message.value = 'No hemos podido buscar productos. Vuelve a pulsar «Buscar».'
  } finally {
    if (current()) loading.value = false
  }
}
function choose(item: Candidate) {
  if (!props.available || loading.value || !results.value.includes(item)) return
  const turn = epoch,
    owner = props.authority
  emit('update:modelValue', item.uuid)
  // Parent v-model updates synchronously; defer only the descriptive label.
  nextTick(() => {
    if (alive && turn === epoch && props.authority === owner && props.available && props.modelValue === item.uuid)
      selectedName.value = item.name
  })
  results.value = []
}
function manualInput(event: Event) {
  if (!alive || !props.available) return
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}
function clearSelection() {
  if (!alive || !props.available) return
  emit('update:modelValue', '')
}
const chosen = computed(() => String(props.modelValue ?? '').trim())
</script>

<template>
  <div class="mt-3 space-y-3">
    <div
      v-if="chosen"
      class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2"
    >
      <UIcon name="i-lucide-package-check" class="size-4 shrink-0 text-[var(--text-muted)]" />
      <p class="min-w-0 flex-1 break-words font-medium text-[var(--text-strong)]">
        <template v-if="selectedName">Seleccionado: {{ selectedName }}</template>
        <template v-else>
          Producto ya elegido
          <span class="whitespace-nowrap font-normal text-[var(--text-muted)]">
            #{{ chosen.slice(0, 8).toUpperCase() }}
          </span>
        </template>
      </p>
      <button type="button" class="adm-btn adm-btn--ghost adm-btn--sm" :disabled="!available" @click="clearSelection">
        Quitar
      </button>
    </div>
    <AdminFormField
      v-slot="{ id }"
      :label="chosen ? `${label}: cambiar de producto` : `${label}: elige un producto`"
      help="Busca por nombre o referencia (al menos 2 letras) y elige uno de la lista."
    >
      <div class="flex gap-2">
        <input
          :id="id"
          v-model="query"
          data-reference-query
          type="search"
          maxlength="100"
          placeholder="Buscar producto…"
          autocomplete="off"
          :disabled="!available"
          class="adm-input min-w-0 flex-1"
          @keydown.enter.prevent="search"
        />
        <button
          data-reference-search
          type="button"
          :disabled="!available || loading || !validQuery"
          class="adm-btn adm-btn--secondary shrink-0"
          @click="search"
        >
          <UIcon
            :name="loading ? 'i-lucide-loader-circle' : 'i-lucide-search'"
            class="size-4 shrink-0"
            :class="loading && 'animate-spin'"
          />
          {{ loading ? 'Buscando…' : 'Buscar' }}
        </button>
      </div>
    </AdminFormField>
    <ul
      v-if="results.length"
      class="max-h-72 divide-y divide-[var(--border)] overflow-y-auto rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)]"
    >
      <li v-for="item in results" :key="item.uuid">
        <button
          type="button"
          :data-reference-option="item.uuid"
          :disabled="!available"
          class="flex w-full flex-wrap items-baseline gap-x-2 px-3 py-2 text-left hover:bg-[var(--surface-sunken)] disabled:opacity-50"
          @click="choose(item)"
        >
          <span class="break-words font-medium text-[var(--text-strong)]">{{ item.name }}</span>
          <span v-if="item.brand" class="text-[var(--text-muted)]">{{ item.brand }}</span>
        </button>
      </li>
    </ul>
    <p v-if="message" role="status" class="adm-help">{{ message }}</p>
    <details>
      <summary class="adm-help cursor-pointer">¿No aparece en la búsqueda? Pega su identificador</summary>
      <AdminFormField
        v-slot="{ id }"
        class="mt-2"
        :label="`${label}: identificador del producto`"
        help="El identificador interno de otro producto, no una dirección web."
      >
        <input
          :id="id"
          :value="modelValue"
          :data-typed-input="definitionId"
          type="text"
          maxlength="36"
          :disabled="!available"
          class="adm-input"
          @input="manualInput"
        />
      </AdminFormField>
    </details>
    <p class="adm-help">Al guardar se comprueba de nuevo que el producto sigue disponible.</p>
  </div>
</template>
