<script setup lang="ts">
import {
  buildMediaPublicationPayload,
  mediaPublicationError,
  publicationLocalTime,
  publicationRoles
} from '~/utils/mediaPublication'
import type { PublicationRole } from '~/utils/mediaPublication'

const props = defineProps<{
  asset: { id: string; originalName: string; mimeType: string; altText: string | null; canPublish?: boolean }
}>()
const emit = defineEmits<{ close: []; published: [] }>()
interface Product {
  id: number
  uuid: string
  name: string
}
interface Variant {
  uuid: string
  sku: string
  format: string
}
interface ProductDetail extends Product {
  variants: Variant[]
}
const products = ref<Product[]>([])
const detail = ref<ProductDetail | null>(null)
const search = ref('')
const selected = ref('')
const selectedVariant = ref('product-level')
const loading = ref(false)
const loadingDetail = ref(false)
const saving = ref(false)
const error = ref('')
const catalogReadable = ref(false)
const canPublish = computed(() => props.asset.canPublish === true)
const roles = computed(() => publicationRoles(props.asset.mimeType))
const form = reactive({
  role: roles.value[0]?.value ?? ('image' as PublicationRole),
  title: props.asset.originalName,
  altText: props.asset.altText ?? '',
  language: 'es',
  version: '1',
  validFromLocal: publicationLocalTime(),
  validUntilLocal: ''
})
const productOptions = computed(() => products.value.map((product) => ({ label: product.name, value: product.uuid })))
const variantOptions = computed(() => [
  { label: 'Producto completo (sin SKU específico)', value: 'product-level' },
  ...(detail.value?.variants ?? []).map((variant) => ({
    label: `${variant.sku} · ${variant.format}`,
    value: variant.uuid
  }))
])
const command = ref<{ payload: string; key: string } | null>(null)
let loadGeneration = 0
let detailGeneration = 0
const payload = computed(() => {
  if (
    !canPublish.value ||
    !catalogReadable.value ||
    !detail.value ||
    detail.value.uuid !== selected.value ||
    loadingDetail.value
  )
    return null
  if (
    selectedVariant.value !== 'product-level' &&
    !detail.value.variants.some((variant) => variant.uuid === selectedVariant.value)
  )
    return null
  return buildMediaPublicationPayload({
    ...form,
    productId: detail.value.uuid,
    variantId: selectedVariant.value === 'product-level' ? null : selectedVariant.value,
    mimeType: props.asset.mimeType
  })
})

async function loadProducts() {
  if (!canPublish.value) return
  const generation = ++loadGeneration
  loading.value = true
  error.value = ''
  try {
    const result = await $fetch<{ source: string; items: Product[]; capabilities?: { productsRead?: boolean } }>(
      '/api/admin/products',
      {
        query: { q: search.value, page: 1, perPage: 50 }
      }
    )
    if (generation !== loadGeneration) return
    if (result.source !== 'cloudflare' || result.capabilities?.productsRead !== true)
      throw new Error('catalog_unavailable')
    catalogReadable.value = true
    products.value = result.items
    if (selected.value && !products.value.some((product) => product.uuid === selected.value)) selected.value = ''
  } catch {
    if (generation !== loadGeneration) return
    catalogReadable.value = false
    products.value = []
    error.value = 'No se ha podido consultar el catálogo autorizado. Vuelve a intentarlo.'
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

watch(selected, async (uuid) => {
  const generation = ++detailGeneration
  detail.value = null
  loadingDetail.value = false
  selectedVariant.value = 'product-level'
  const product = products.value.find((item) => item.uuid === uuid)
  if (!product || !canPublish.value) return
  loadingDetail.value = true
  error.value = ''
  try {
    const result = await $fetch<ProductDetail & { source: string; capabilities?: { productDetailRead?: boolean } }>(
      `/api/admin/products/${product.id}`
    )
    if (generation !== detailGeneration) return
    if (result.uuid !== uuid || result.source !== 'cloudflare' || result.capabilities?.productDetailRead !== true)
      throw new Error('catalog_unavailable')
    detail.value = result
  } catch {
    if (generation === detailGeneration)
      error.value = 'No se ha podido cargar este producto. Selecciona otro o vuelve a intentarlo.'
  } finally {
    if (generation === detailGeneration) loadingDetail.value = false
  }
})

async function publish() {
  const body = payload.value
  if (!body || saving.value) return
  const canonical = JSON.stringify(body)
  if (command.value?.payload !== canonical) command.value = { payload: canonical, key: crypto.randomUUID() }
  saving.value = true
  error.value = ''
  try {
    // Worker-owned route; do not infer the ordinary Node profile's /media/:id PUT contract.
    const endpoint: string = `/api/admin/media/${props.asset.id}/publications`
    await $fetch(endpoint, {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': command.value.key }
    })
    emit('published')
    emit('close')
  } catch (cause) {
    error.value = mediaPublicationError(cause)
  } finally {
    saving.value = false
  }
}

onMounted(loadProducts)
onBeforeUnmount(() => {
  ++loadGeneration
  ++detailGeneration
})
</script>

<template>
  <UModal
    :open="true"
    title="Asociar archivo a producto"
    description="Elige el producto en el que se usará este archivo."
    @update:open="(open) => !open && !saving && emit('close')"
  >
    <template #body>
      <form id="media-publication-form" class="adm-stack" @submit.prevent="publish">
        <p class="break-words text-sm font-semibold text-[var(--text-strong)]">{{ asset.originalName }}</p>
        <UAlert
          v-if="!canPublish"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Este archivo no se puede publicar"
          description="Comprueba que tiene los derechos aprobados y el análisis de seguridad superado."
        />
        <UAlert
          v-if="error"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="error"
        />
        <fieldset :disabled="!canPublish || saving" class="space-y-4">
          <div class="flex items-end gap-2">
            <UFormField label="Buscar producto" class="flex-1">
              <UInput v-model="search" maxlength="160" class="w-full" @keydown.enter.prevent="loadProducts" />
            </UFormField>
            <UButton color="neutral" variant="outline" :loading="loading" :disabled="saving" @click="loadProducts"
              >Buscar</UButton
            >
          </div>
          <UFormField
            label="Producto"
            required
            :hint="
              loading
                ? 'Cargando catálogo…'
                : 'Se muestran hasta 50 resultados. Usa la búsqueda para encontrar el producto.'
            "
          >
            <USelect
              v-model="selected"
              :items="productOptions"
              :disabled="loading || !catalogReadable"
              placeholder="Selecciona un producto"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Variante / SKU"
            :hint="loadingDetail ? 'Cargando variantes…' : 'Si eliges una variante, el archivo solo se usa en ella.'"
          >
            <USelect
              v-model="selectedVariant"
              :items="variantOptions"
              :disabled="!detail || loadingDetail"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Uso del archivo" required>
            <USelect v-model="form.role" :items="roles" class="w-full" />
          </UFormField>
          <UFormField label="Título" required
            ><UInput v-model="form.title" maxlength="200" required class="w-full"
          /></UFormField>
          <UFormField
            label="Texto alternativo / descripción"
            required
            hint="Al menos 5 caracteres. Describe lo que se ve, no repitas el nombre del archivo."
          >
            <UTextarea v-model="form.altText" minlength="5" maxlength="500" required class="w-full" />
          </UFormField>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Idioma" required
              ><UInput v-model="form.language" maxlength="35" required class="w-full"
            /></UFormField>
            <UFormField label="Versión" required
              ><UInput v-model="form.version" maxlength="100" required class="w-full"
            /></UFormField>
            <UFormField label="Inicio de vigencia" required hint="Hora local."
              ><UInput v-model="form.validFromLocal" type="datetime-local" :step="1" required class="w-full"
            /></UFormField>
            <UFormField label="Fin de vigencia" hint="Opcional. Debe ser posterior al inicio."
              ><UInput v-model="form.validUntilLocal" type="datetime-local" :step="1" class="w-full"
            /></UFormField>
          </div>
        </fieldset>
        <p class="text-xs text-[var(--text-muted)]">
          Asociarlo no lo publica por sí solo: el archivo se verá en la tienda cuando tenga los derechos aprobados, el
          análisis de seguridad superado y el producto esté publicado.
        </p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="emit('close')">Cancelar</UButton>
        <UButton type="submit" form="media-publication-form" :disabled="!payload" :loading="saving"
          >Crear asociación</UButton
        >
      </div>
    </template>
  </UModal>
</template>
