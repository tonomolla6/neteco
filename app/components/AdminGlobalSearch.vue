<script setup lang="ts">
import type { AdminNavigationLink } from '~~/shared/admin-navigation'
import {
  adminGlobalSearchQuerySchema,
  adminGlobalSearchResponseSchema,
  type AdminGlobalSearchItem
} from '~~/shared/admin-global-search'
const props = defineProps<{
  scopeKey: string
  enabled: boolean
  pending: boolean
  groups: Array<{ label: string; links: AdminNavigationLink[] }>
}>()
const request = useRequestFetch(),
  prefix = useId()
const query = ref(''),
  items = shallowRef<AdminGlobalSearchItem[]>([])
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle'),
  validation = ref('')
const roots = computed(() =>
  [
    ...new Set(
      props.groups
        .flatMap((group) => group.links.map((link) => link.to))
        .filter((to) => to === '/admin/productos' || to === '/admin/pedidos')
    )
  ].sort()
)
const fingerprint = computed(() => JSON.stringify(roots.value))
const allowed = computed(() => props.enabled && !props.pending && !!props.scopeKey && roots.value.length > 0)
let alive = true,
  generation = 0,
  controller: AbortController | null = null,
  attemptedQuery: string | null = null
function invalidate() {
  generation++
  controller?.abort()
  controller = null
  items.value = []
  status.value = 'idle'
  validation.value = ''
  attemptedQuery = null
}
watch(query, invalidate, { flush: 'sync' })
watch(
  [() => props.scopeKey, () => props.enabled, () => props.pending, fingerprint],
  () => {
    invalidate()
    query.value = ''
  },
  { flush: 'sync' }
)
function current(epoch: number, scope: string) {
  return alive && allowed.value && epoch === generation && scope === props.scopeKey
}
async function read(q: string) {
  if (!alive || !allowed.value || status.value === 'loading') return
  const epoch = generation,
    scope = props.scopeKey,
    abort = new AbortController()
  controller = abort
  attemptedQuery = q
  items.value = []
  validation.value = ''
  status.value = 'loading'
  try {
    const raw = await request('/api/admin/global-search', {
      method: 'GET',
      query: { q, limit: 10 },
      cache: 'no-store',
      retry: 0,
      signal: abort.signal
    })
    if (!current(epoch, scope)) return
    const result = adminGlobalSearchResponseSchema.parse(raw)
    if (
      result.query !== q ||
      result.items.length > 10 ||
      new Set(result.items.map((item) => `${item.kind}:${item.id}`)).size !== result.items.length ||
      result.items.some(
        (item) => !roots.value.includes(item.kind === 'product' ? '/admin/productos' : '/admin/pedidos')
      )
    )
      throw new Error('unconfirmed_search')
    items.value = result.items
    status.value = 'ready'
  } catch {
    if (current(epoch, scope)) {
      items.value = []
      status.value = 'error'
    }
  } finally {
    if (current(epoch, scope)) controller = null
  }
}
function submit() {
  if (!alive || !allowed.value || status.value === 'loading') return
  const result = adminGlobalSearchQuerySchema.safeParse(query.value)
  if (!result.success) {
    validation.value = 'Escribe entre 2 y 100 caracteres, sin caracteres de control.'
    return
  }
  void read(result.data)
}
function retry() {
  if (status.value === 'error' && attemptedQuery !== null) void read(attemptedQuery)
}
onBeforeUnmount(() => {
  alive = false
  invalidate()
  query.value = ''
})
</script>
<template>
  <section v-if="allowed" :aria-labelledby="prefix + '-title'" class="min-w-0 max-w-full space-y-3">
    <h2 :id="prefix + '-title'" class="text-base font-semibold">Buscar productos y pedidos</h2>
    <p class="text-sm text-muted">
      Consulta nombres, referencias de producto o identificadores de pedido según tus permisos.
    </p>
    <form class="flex min-w-0 flex-wrap items-end gap-2" @submit.prevent="submit">
      <div class="min-w-0 flex-1">
        <label :for="prefix + '-query'" class="block text-sm">Buscar productos y pedidos</label>
        <input
          :id="prefix + '-query'"
          v-model="query"
          type="search"
          autocomplete="off"
          maxlength="100"
          :aria-describedby="prefix + '-hint'"
          class="w-full rounded border px-3 py-2 focus-visible:outline-2"
        />
      </div>
      <button type="submit" :disabled="status === 'loading'" class="rounded border px-3 py-2 focus-visible:outline-2">
        Buscar
      </button>
    </form>
    <p :id="prefix + '-hint'" class="text-xs text-muted">
      Entre 2 y 100 caracteres. La búsqueda se envía sólo al confirmar.
    </p>
    <p v-if="validation" role="alert" class="text-sm">{{ validation }}</p>
    <p v-if="status === 'loading'" data-search-loading role="status" aria-busy="true" class="text-sm">
      Consultando productos y pedidos…
    </p>
    <div v-else-if="status === 'error'" data-search-error role="alert" class="space-y-2 text-sm">
      <p>No se ha podido confirmar la búsqueda. Puedes volver a intentarlo.</p>
      <button data-search-retry type="button" class="rounded border px-3 py-2 focus-visible:outline-2" @click="retry">
        Reintentar búsqueda
      </button>
    </div>
    <p v-else-if="status === 'ready' && !items.length" data-search-empty role="status" class="text-sm">
      No se han encontrado productos ni pedidos según tus permisos.
    </p>
    <ul
      v-else-if="status === 'ready'"
      class="min-w-0 divide-y divide-[var(--border)]"
      aria-label="Resultados de búsqueda"
    >
      <li
        v-for="item in items"
        :key="item.kind + ':' + item.id"
        data-search-item
        class="min-w-0 break-words py-3 [overflow-wrap:anywhere]"
      >
        <NuxtLink :to="item.to" class="underline focus-visible:outline-2">{{ item.label }}</NuxtLink>
        <p class="text-xs text-muted">{{ item.kind === 'product' ? 'Producto' : 'Pedido' }} · {{ item.description }}</p>
      </li>
    </ul>
  </section>
</template>
