<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })

const route = useRoute()
const id = String(route.params.id)
const isNew = id === 'nuevo'
useSeoMeta({ title: isNew ? 'Nuevo producto · Admin' : 'Editar producto · Admin' })

const { data: catData } = await useFetch('/api/categories', { key: 'categories' })
const catOptions = computed(() => flattenCategoryTree((catData.value as any)?.roots ?? []))

const { data: existing } = await useAsyncData(`admin-product-${id}`, () =>
  isNew ? Promise.resolve(null) : $fetch(`/api/admin/products/${id}`)
)
if (!isNew && !existing.value) {
  throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado', fatal: true })
}

const VISUAL_TYPES = [
  'garrafa',
  'botella',
  'spray',
  'caja',
  'saco',
  'capsulas',
  'difusor',
  'cubo',
  'rollo',
  'vaso',
  'guante'
]

const e = existing.value as any
const form = reactive({
  name: e?.name ?? '',
  brand: e?.brand ?? '',
  categoryId: e?.categoryId ?? null,
  shortDesc: e?.shortDesc ?? '',
  description: e?.description ?? '',
  usage: e?.usage ?? '',
  badges: [...(e?.badges ?? [])] as string[],
  visual: { type: e?.visual?.type ?? 'caja', color: e?.visual?.color ?? '#009ac9' },
  featured: !!e?.featured,
  active: e?.active ?? true,
  series: e?.series ?? '',
  variants: (e?.variants ?? []).map((v: any) => ({
    id: v.id,
    format: v.format,
    sku: v.sku,
    price: v.price / 100,
    stock: v.stock,
    color: v.color ?? '',
    image: v.image ?? ''
  })) as Array<{
    id?: number
    format: string
    sku: string
    price: number | null
    stock: number
    color: string
    image: string
  }>
})
if (!form.variants.length) form.variants.push({ format: '', sku: '', price: null, stock: 100, color: '', image: '' })

function toggleBadge(b: string) {
  form.badges = form.badges.includes(b) ? form.badges.filter((x) => x !== b) : [...form.badges, b]
}
function addVariant() {
  form.variants.push({ format: '', sku: '', price: null, stock: 100, color: '', image: '' })
}
function removeVariant(i: number) {
  form.variants.splice(i, 1)
}

const toast = useToast()
const saving = ref(false)

async function save() {
  saving.value = true
  try {
    const payload = {
      name: form.name,
      brand: form.brand,
      categoryId: Number(form.categoryId),
      shortDesc: form.shortDesc,
      description: form.description,
      usage: form.usage || null,
      badges: form.badges,
      visual: form.visual,
      featured: form.featured,
      active: form.active,
      series: form.series || null,
      variants: form.variants.map((v) => ({
        ...(v.id != null ? { id: v.id } : {}),
        format: v.format,
        sku: v.sku || null,
        price: Number(v.price),
        stock: Number(v.stock),
        color: v.color || null,
        image: v.image || null
      }))
    }
    if (isNew) await $fetch('/api/admin/products', { method: 'POST', body: payload })
    else await $fetch(`/api/admin/products/${id}`, { method: 'PUT', body: payload })
    toast.add({ title: isNew ? 'Producto creado' : 'Cambios guardados', icon: 'i-lucide-check', color: 'success' })
    refreshNuxtData('categories')
    navigateTo('/admin/productos')
  } catch (err: any) {
    toast.add({
      title: err?.data?.statusMessage ?? err?.data?.message ?? 'No se ha podido guardar',
      color: 'error',
      icon: 'i-lucide-alert-circle'
    })
  } finally {
    saving.value = false
  }
}

async function removeProduct() {
  if (!confirm(`¿Eliminar «${form.name}»? Esta acción no se puede deshacer.`)) return
  await $fetch(`/api/admin/products/${id}`, { method: 'DELETE' })
  toast.add({ title: 'Producto eliminado', icon: 'i-lucide-trash-2', color: 'success' })
  refreshNuxtData('categories')
  navigateTo('/admin/productos')
}
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-bold text-slate-900">{{ isNew ? 'Nuevo producto' : 'Editar producto' }}</h1>
      <NuxtLink to="/admin/productos" class="text-sm text-slate-500 hover:text-neteco-600"
        >← Volver al listado</NuxtLink
      >
    </div>

    <form class="mt-6 space-y-6" @submit.prevent="save">
      <!-- datos principales -->
      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="font-bold text-slate-900">Datos principales</h2>
        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <UFormField label="Nombre (con el envase entre paréntesis)" class="sm:col-span-2">
            <UInput v-model="form.name" class="w-full" placeholder="Guante de nitrilo Nitriflex Blue (caja 100 uds)" />
          </UFormField>
          <UFormField label="Marca" hint="Opcional">
            <UInput v-model="form.brand" class="w-full" />
          </UFormField>
          <UFormField label="Familia">
            <select
              v-model="form.categoryId"
              class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-neteco-500 focus:outline-none"
            >
              <option :value="null" disabled>Elige una familia…</option>
              <option v-for="c in catOptions" :key="c.id" :value="c.id">{{ c.label }}</option>
            </select>
          </UFormField>
          <UFormField label="Gama (enlaza colores/versiones hermanas)" hint="Opcional">
            <UInput v-model="form.series" class="w-full" placeholder="guantes-nitriflex" />
          </UFormField>
          <div class="flex flex-wrap items-end gap-6 pb-1">
            <label class="flex items-center gap-2 text-sm text-slate-700">
              <input v-model="form.featured" type="checkbox" class="size-4 accent-neteco-600" /> Destacado en portada
            </label>
            <label class="flex items-center gap-2 text-sm text-slate-700">
              <input v-model="form.active" type="checkbox" class="size-4 accent-neteco-600" /> Visible en la tienda
            </label>
          </div>
        </div>

        <div class="mt-4 flex flex-wrap gap-4">
          <span class="text-sm font-medium text-slate-700">Sellos:</span>
          <label v-for="(b, key) in BADGES" :key="key" class="flex items-center gap-1.5 text-sm text-slate-600">
            <input
              type="checkbox"
              :checked="form.badges.includes(String(key))"
              class="size-4 accent-neteco-600"
              @change="toggleBadge(String(key))"
            />
            {{ b.label }}
          </label>
        </div>
      </section>

      <!-- textos -->
      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="font-bold text-slate-900">Textos</h2>
        <div class="mt-4 space-y-4">
          <UFormField label="Descripción corta (tarjetas y buscador)">
            <UTextarea v-model="form.shortDesc" :rows="2" class="w-full" />
          </UFormField>
          <UFormField label="Descripción completa">
            <UTextarea v-model="form.description" :rows="4" class="w-full" />
          </UFormField>
          <UFormField label="Modo de empleo y dosificación" hint="Opcional">
            <UTextarea v-model="form.usage" :rows="2" class="w-full" />
          </UFormField>
        </div>
      </section>

      <!-- visual -->
      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="font-bold text-slate-900">Ilustración provisional</h2>
        <p class="mt-1 text-sm text-slate-500">
          Hasta que haya fotos reales, cada producto usa un envase dibujado con un color identificativo.
        </p>
        <div class="mt-4 flex flex-wrap items-center gap-6">
          <div class="w-28"><ProductVisual :visual="form.visual" /></div>
          <UFormField label="Tipo de envase">
            <select
              v-model="form.visual.type"
              class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-neteco-500 focus:outline-none"
            >
              <option v-for="t in VISUAL_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
          </UFormField>
          <UFormField label="Color">
            <input
              v-model="form.visual.color"
              type="color"
              class="h-9 w-16 cursor-pointer rounded border border-slate-300"
            />
          </UFormField>
        </div>
      </section>

      <!-- variantes -->
      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <div class="flex items-center justify-between">
          <h2 class="font-bold text-slate-900">Variantes (formatos / tallas)</h2>
          <UButton size="sm" variant="soft" icon="i-lucide-plus" @click="addVariant">Añadir variante</UButton>
        </div>
        <p class="mt-1 text-sm text-slate-500">
          La <strong>referencia</strong> debe ser el código de artículo del ERP. El precio va en euros,
          <strong>IVA incluido</strong>; el €/ud–€/L se calcula solo a partir del formato.
        </p>
        <div class="mt-4 space-y-2">
          <div
            v-for="(v, i) in form.variants"
            :key="i"
            class="grid grid-cols-2 items-end gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-[1fr_6.5rem_6.5rem_9rem_6rem_4.5rem_auto]"
          >
            <UFormField label="Formato" :ui="{ label: 'text-xs' }">
              <UInput v-model="v.format" placeholder="Talla M · Garrafa 5 L…" class="w-full" />
            </UFormField>
            <UFormField label="Referencia ERP" :ui="{ label: 'text-xs' }">
              <UInput v-model="v.sku" placeholder="1133" class="w-full" />
            </UFormField>
            <UFormField
              label="Color (hex)"
              :ui="{ label: 'text-xs' }"
              class="order-last col-span-2 sm:order-none sm:col-span-1"
            >
              <div class="flex items-center gap-1.5">
                <span
                  class="size-5 shrink-0 rounded-full border border-black/15"
                  :style="{ backgroundColor: v.color || '#ffffff' }"
                />
                <input
                  v-model="v.color"
                  placeholder="#f7c600"
                  class="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs focus:border-neteco-500 focus:outline-none"
                />
              </div>
            </UFormField>
            <UFormField
              label="Imagen (ruta)"
              :ui="{ label: 'text-xs' }"
              class="order-last col-span-2 sm:order-none sm:col-span-1"
            >
              <UInput v-model="v.image" placeholder="/img/products/…" class="w-full" />
            </UFormField>
            <UFormField label="Precio € (IVA inc.)" :ui="{ label: 'text-xs' }">
              <input
                v-model.number="v.price"
                type="number"
                step="0.01"
                min="0"
                class="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-neteco-500 focus:outline-none"
              />
            </UFormField>
            <UFormField label="Stock" :ui="{ label: 'text-xs' }">
              <input
                v-model.number="v.stock"
                type="number"
                min="0"
                class="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-neteco-500 focus:outline-none"
              />
            </UFormField>
            <UButton
              size="sm"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              aria-label="Quitar variante"
              :disabled="form.variants.length <= 1"
              @click="removeVariant(i)"
            />
          </div>
        </div>
      </section>

      <div class="flex flex-wrap items-center justify-between gap-3 pb-10">
        <UButton v-if="!isNew" color="error" variant="soft" icon="i-lucide-trash-2" @click="removeProduct"
          >Eliminar producto</UButton
        >
        <span v-else />
        <div class="flex gap-2">
          <UButton to="/admin/productos" variant="ghost" color="neutral">Cancelar</UButton>
          <UButton type="submit" icon="i-lucide-save" :loading="saving">{{
            isNew ? 'Crear producto' : 'Guardar cambios'
          }}</UButton>
        </div>
      </div>
    </form>
  </div>
</template>
