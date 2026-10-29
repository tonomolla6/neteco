<script setup lang="ts">
import {
  publicCatalogRelationsSchema,
  catalogRelationSlugsSchema,
  type PublicCatalogRelations
} from '~~/shared/catalog-relations'
const props = defineProps<{ productSlugs: string[] }>()
const request = useRequestFetch(),
  runtime = useRuntimeConfig()
const origins = computed(() => [...new Set(props.productSlugs)])
const groups = shallowRef<PublicCatalogRelations['groups']>([])
const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const labels = {
  substitute: 'Sustitución',
  compatible: 'Compatibilidad',
  accessory: 'Accesorios',
  equivalent: 'Equivalencia'
}
let generation = 0,
  alive = true
async function load() {
  if (state.value === 'loading') return
  const token = ++generation,
    slugs = [...origins.value]
  groups.value = []
  if (runtime.public.serverRuntime !== 'cloudflare' || !slugs.length) {
    state.value = 'idle'
    return
  }
  state.value = 'loading'
  try {
    const collected: PublicCatalogRelations['groups'] = []
    for (let offset = 0; offset < slugs.length; offset += 20) {
      const batch = catalogRelationSlugsSchema.parse(slugs.slice(offset, offset + 20))
      const parsed = publicCatalogRelationsSchema.parse(
        await request('/api/product-relations', { query: { slugs: batch.join(',') }, retry: 0 })
      )
      if (!alive || token !== generation) return
      if (
        new Set(parsed.groups.map((g) => g.productSlug)).size !== parsed.groups.length ||
        parsed.groups.some((g) => !batch.includes(g.productSlug))
      )
        throw new Error('correlation')
      collected.push(...parsed.groups)
    }
    if (alive && token === generation) {
      groups.value = collected
      state.value = 'ready'
    }
  } catch {
    if (alive && token === generation) {
      groups.value = []
      state.value = 'error'
    }
  }
}
watch(
  origins,
  () => {
    generation++
    state.value = 'idle'
    groups.value = []
    void load()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  generation++
  groups.value = []
})
const money = (cents: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
</script>

<template>
  <section
    v-if="runtime.public.serverRuntime === 'cloudflare' && origins.length"
    aria-label="Relaciones publicadas de productos"
    class="min-w-0 space-y-3"
  >
    <h2>Relaciones publicadas de productos</h2>
    <p>
      La relación es dirigida y no confirma compatibilidad química. Revise la documentación antes de utilizar el
      producto.
    </p>
    <p v-if="state === 'loading'" role="status">Consultando relaciones publicadas…</p>
    <p v-else-if="state === 'error'" role="alert">No se pudieron consultar las relaciones publicadas.</p>
    <template v-else-if="state === 'ready'">
      <p v-if="groups.every((group) => !group.items.length)">No hay relaciones publicadas.</p>
      <div v-for="group in groups" :key="group.productSlug" class="min-w-0 space-y-2">
        <p>{{ group.productSlug }}</p>
        <section v-for="(label, kind) in labels" :key="kind">
          <h3>{{ label }}</h3>
          <ul class="space-y-2">
            <li
              v-for="item in group.items.filter((item) => item.kind === kind)"
              :key="item.productId"
              class="break-words"
            >
              <a :href="'/producto/' + encodeURIComponent(item.slug)" class="underline">{{ item.name }}</a>
              — {{ item.brand }} · Desde {{ money(item.minPrice) }} IVA incluido ({{ money(item.minNetPrice) }} sin IVA)
            </li>
          </ul>
        </section>
      </div>
    </template>
    <button data-relations-refresh type="button" :disabled="state === 'loading'" @click="load">
      Actualizar relaciones
    </button>
  </section>
</template>
