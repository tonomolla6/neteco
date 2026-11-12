<script setup lang="ts">
import { onServerPrefetch } from 'vue'
import {
  resourceHubDetailSchema,
  resourceHubListSchema,
  resourceHubQuerySchema,
  type ResourceHubDetail,
  type ResourceHubList
} from '~~/shared/resource-hub'
import CmsContentBlocks from './CmsContentBlocks.vue'
const props = defineProps<{ slug?: string; enabled: boolean }>()
const emit = defineEmits<{ confirmed: [value: ResourceHubDetail | ResourceHubList | null] }>()
const route = useRoute(),
  router = useRouter(),
  request = useRequestFetch(),
  listing = shallowRef<ResourceHubList | null>(null),
  detail = shallowRef<ResourceHubDetail | null>(null)
const query = ref(''),
  category = ref(''),
  kind = ref(''),
  loading = ref(false),
  failed = ref(false)
let generation = 0,
  alive = true,
  controller: AbortController | null = null
let pendingLoad: Promise<void> = Promise.resolve()
const routeQuery = computed(() => ({
  q: route.query.q,
  category: route.query.category,
  kind: route.query.kind,
  page: route.query.page,
  perPage: 20
}))
function paginationQuery(page: number) {
  const current = resourceHubQuerySchema.parse(routeQuery.value)
  return {
    ...(current.q ? { q: current.q } : {}),
    ...(current.category ? { category: current.category } : {}),
    ...(current.kind ? { kind: current.kind } : {}),
    ...(page > 1 ? { page: String(page) } : {})
  }
}
async function search() {
  const input = resourceHubQuerySchema.safeParse({
    q: query.value,
    ...(category.value ? { category: category.value } : {}),
    ...(kind.value ? { kind: kind.value } : {})
  })
  if (!input.success) {
    purge()
    failed.value = true
    return
  }
  const target = {
    path: '/recursos',
    query: {
      ...(input.data.q ? { q: input.data.q } : {}),
      ...(input.data.category ? { category: input.data.category } : {}),
      ...(input.data.kind ? { kind: input.data.kind } : {})
    }
  }
  if (router.resolve(target).fullPath === route.fullPath) pendingLoad = load()
  else await router.push(target)
}
function purge() {
  generation++
  controller?.abort()
  controller = null
  listing.value = null
  detail.value = null
  failed.value = false
  loading.value = false
  emit('confirmed', null)
}
async function load() {
  purge()
  if (!props.enabled) return
  const epoch = generation
  controller = new AbortController()
  loading.value = true
  try {
    const input = props.slug ? null : resourceHubQuerySchema.parse(routeQuery.value)
    if (input) {
      query.value = input.q
      category.value = input.category ?? ''
      kind.value = input.kind ?? ''
    }
    const dto = props.slug
      ? resourceHubDetailSchema.parse(
          await request(`/api/resources/${encodeURIComponent(props.slug)}`, { signal: controller.signal, retry: 0 })
        )
      : resourceHubListSchema.parse(
          await request('/api/resources', {
            query: input!,
            signal: controller.signal,
            retry: 0
          })
        )
    if (!alive || epoch !== generation || !props.enabled) return
    if ('blocks' in dto) {
      if (dto.slug !== props.slug) throw Error('source')
      detail.value = dto
    } else listing.value = dto
    emit('confirmed', dto)
  } catch {
    if (alive && epoch === generation) failed.value = true
  } finally {
    if (alive && epoch === generation) loading.value = false
  }
}
watch(
  () => [props.slug, props.enabled, props.slug ? null : JSON.stringify(routeQuery.value)],
  () => {
    query.value = ''
    category.value = ''
    kind.value = ''
    pendingLoad = load()
  },
  { immediate: true, flush: 'sync' }
)
onServerPrefetch(() => pendingLoad)
onBeforeUnmount(() => {
  alive = false
  purge()
})
const date = (value: string) =>
  new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', dateStyle: 'long' }).format(new Date(value)) + ' UTC'
</script>
<template>
  <section aria-label="Centro de recursos" class="mx-auto max-w-5xl min-w-0 space-y-6 px-4 py-8">
    <p v-if="!enabled" role="status">El centro de recursos no está disponible ahora mismo.</p>
    <template v-else>
      <form v-if="!slug" data-resource-search class="flex flex-wrap items-end gap-3" @submit.prevent="search">
        <label class="min-w-0 flex-1"
          >Buscar recursos<input
            v-model="query"
            data-resource-query
            maxlength="80"
            class="block w-full"
            :disabled="loading"
        /></label>
        <label
          >Categoría<select v-model="category" data-resource-category :disabled="loading">
            <option value="">Todas</option>
            <option v-for="item in listing?.categories ?? []" :key="item.slug" :value="item.slug">
              {{ item.label }}
            </option>
          </select></label
        >
        <label
          >Tipo<select v-model="kind" :disabled="loading">
            <option value="">Todos</option>
            <option value="pillar">Guías pilares</option>
            <option value="article">Artículos</option>
            <option value="landing">Problemas y sectores</option>
          </select></label
        >
        <button type="submit" :disabled="loading">Buscar recursos</button>
      </form>
      <p v-if="loading" role="status">Confirmando contenido publicado…</p>
      <p v-if="failed" role="alert">
        No se ha podido confirmar el contenido vigente. No se muestran versiones anteriores.
      </p>
      <div v-if="listing" class="space-y-5">
        <p v-if="!listing.items.length">No hay recursos publicados para esta consulta.</p>
        <ul class="grid gap-5 sm:grid-cols-2">
          <li v-for="item in listing.items" :key="item.slug" class="min-w-0 rounded-lg border p-4">
            <p>
              {{ item.editorial.category.label }} ·
              {{
                item.editorial.kind === 'pillar'
                  ? 'Guía pilar'
                  : item.editorial.kind === 'landing'
                    ? 'Problema / sector'
                    : 'Artículo'
              }}
            </p>
            <h2 class="text-xl font-semibold">
              <NuxtLink :to="item.canonicalPath">{{ item.title }}</NuxtLink>
            </h2>
            <p>{{ item.description }}</p>
            <p>
              {{ item.editorial.author.name }} · Revisado
              <time :datetime="item.editorial.reviewedAt">{{ date(item.editorial.reviewedAt) }}</time>
            </p>
          </li>
        </ul>
        <nav v-if="listing.pages > 1" aria-label="Páginas de recursos" class="flex gap-3">
          <NuxtLink v-if="listing.page > 1" :to="{ path: '/recursos', query: paginationQuery(listing.page - 1) }"
            >Anteriores</NuxtLink
          ><span>{{ listing.page }} / {{ listing.pages }}</span
          ><NuxtLink
            v-if="listing.page < listing.pages"
            :to="{ path: '/recursos', query: paginationQuery(listing.page + 1) }"
          >
            Siguientes
          </NuxtLink>
        </nav>
      </div>
      <article v-if="detail" class="space-y-6 break-words">
        <header>
          <p>{{ detail.editorial.category.label }}</p>
          <h1 class="text-3xl font-bold">{{ detail.title }}</h1>
          <p>{{ detail.description }}</p>
          <p>Autoría: {{ detail.editorial.author.name }}</p>
          <p>{{ detail.editorial.author.experience }}</p>
          <dl class="grid gap-2 sm:grid-cols-2">
            <dt>Publicación</dt>
            <dd>
              <time :datetime="detail.publishedAt">{{ date(detail.publishedAt) }}</time>
            </dd>
            <dt>Revisión editorial</dt>
            <dd>
              <time :datetime="detail.editorial.reviewedAt">{{ date(detail.editorial.reviewedAt) }}</time>
            </dd>
            <dt>Próxima revisión</dt>
            <dd>
              <time :datetime="detail.editorial.reviewDueAt">{{ date(detail.editorial.reviewDueAt) }}</time>
            </dd>
          </dl>
        </header>
        <CmsContentBlocks :blocks="detail.blocks" :media="detail.media" />
        <section v-if="detail.relatedProducts.length">
          <h2 class="text-xl font-semibold">Productos relacionados publicados</h2>
          <ul>
            <li v-for="item in detail.relatedProducts" :key="item.id">
              <NuxtLink :to="`/producto/${item.slug}`">{{ item.name }}</NuxtLink>
            </li>
          </ul>
        </section>
        <section v-if="detail.relatedCategories.length">
          <h2 class="text-xl font-semibold">Explorar catálogo por categoría</h2>
          <ul>
            <li v-for="item in detail.relatedCategories" :key="item.slug">
              <NuxtLink :to="`/catalogo?familia=${item.slug}`">{{ item.name }}</NuxtLink>
            </li>
          </ul>
        </section>
        <section v-if="detail.relatedResources.length">
          <h2 class="text-xl font-semibold">Pilares y recursos relacionados</h2>
          <ul>
            <li v-for="item in detail.relatedResources" :key="item.slug">
              <NuxtLink :to="item.canonicalPath">{{ item.title }}</NuxtLink>
            </li>
          </ul>
        </section>
      </article>
      <aside class="rounded-lg border p-4">
        <h2 class="font-semibold">Newsletter profesional</h2>
        <p>
          Puedes suscribirte con consentimiento explícito y doble confirmación en el formulario Newsletter del pie de
          página. La lectura no te suscribe.
        </p>
        <a href="#footer-newsletter-email" class="underline">Ir al formulario de newsletter</a>
      </aside>
    </template>
  </section>
</template>
