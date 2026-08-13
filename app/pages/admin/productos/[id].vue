<script setup lang="ts">
import type { AdminProductDetail } from '~~/shared/types/admin'
import type { CategoryResponse } from '~~/shared/types/catalog'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const route = useRoute()
const id = String(route.params.id)
const isNew = id === 'nuevo'
useSeoMeta({ title: isNew ? 'Nuevo producto · Admin' : 'Editar producto · Admin' })

const { data: catData } = await useFetch<CategoryResponse>('/api/categories', { key: 'categories' })
const catOptions = computed(() => flattenCategoryTree(catData.value?.roots ?? []))

const { data: existing } = await useAsyncData(`admin-product-${id}`, () =>
  isNew ? Promise.resolve(null) : $fetch<AdminProductDetail>(`/api/admin/products/${id}`)
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

const product = existing.value
const form = reactive({
  name: product?.name ?? '',
  brand: product?.brand ?? '',
  categoryId: product?.categoryId ?? null,
  shortDesc: product?.shortDesc ?? '',
  description: product?.description ?? '',
  usage: product?.usage ?? '',
  badges: [...(product?.badges ?? [])] as string[],
  visual: { type: product?.visual.type ?? 'caja', color: product?.visual.color ?? '#009ac9' },
  featured: !!product?.featured,
  active: product?.status === 'published',
  series: product?.series ?? '',
  image: product?.image ?? '',
  imageAlt: product?.imageAlt ?? '',
  imageRightsOwner: product?.imageRightsOwner ?? '',
  imageRightsLicense: product?.imageRightsLicense ?? '',
  imageAuthorizedAt: product?.imageAuthorizedAt ?? '',
  attrs: (product?.attrs ?? []).map((attribute) => ({ k: attribute.k, v: attribute.v })),
  variants: (product?.variants ?? []).map((variant) => ({
    id: variant.id,
    format: variant.format,
    sku: variant.sku,
    ean: variant.ean ?? '',
    gtin: variant.gtin ?? '',
    mpn: variant.mpn ?? '',
    identifierExceptionReason: variant.identifierExceptionReason ?? '',
    price: variant.price / 100,
    stock: variant.stock,
    color: variant.color ?? '',
    image: variant.image ?? '',
    unitBase: variant.unitBase,
    unitLabel: variant.unitLabel,
    contentQuantity: variant.units,
    unitsPerCase: variant.unitsPerCase,
    casesPerPallet: variant.casesPerPallet,
    minimumQuantity: variant.minimumQuantity,
    quantityIncrement: variant.quantityIncrement,
    maximumQuantity: variant.maximumQuantity,
    weightGrams: variant.weightGrams,
    widthMm: variant.widthMm,
    heightMm: variant.heightMm,
    depthMm: variant.depthMm,
    safetyStock: variant.safetyStock,
    backorderAllowed: variant.backorderAllowed,
    leadTimeDays: variant.leadTimeDays
  })) as Array<{
    id?: number
    format: string
    sku: string
    ean: string
    gtin: string
    mpn: string
    identifierExceptionReason: string
    price: number | null
    stock: number
    color: string
    image: string
    unitBase: string
    unitLabel: string
    contentQuantity: number
    unitsPerCase: number
    casesPerPallet: number | null
    minimumQuantity: number
    quantityIncrement: number
    maximumQuantity: number | null
    weightGrams: number
    widthMm: number
    heightMm: number
    depthMm: number
    safetyStock: number
    backorderAllowed: boolean
    leadTimeDays: number | null
  }>
})
const emptyVariant = () => ({
  format: '',
  sku: '',
  ean: '',
  gtin: '',
  mpn: '',
  identifierExceptionReason: '',
  price: null,
  stock: 100,
  color: '',
  image: '',
  unitBase: 'unit',
  unitLabel: 'unidad',
  contentQuantity: 1,
  unitsPerCase: 1,
  casesPerPallet: null,
  minimumQuantity: 1,
  quantityIncrement: 1,
  maximumQuantity: null,
  weightGrams: 0,
  widthMm: 0,
  heightMm: 0,
  depthMm: 0,
  safetyStock: 0,
  backorderAllowed: false,
  leadTimeDays: null
})
if (!form.variants.length) form.variants.push(emptyVariant())

function toggleBadge(b: string) {
  form.badges = form.badges.includes(b) ? form.badges.filter((x) => x !== b) : [...form.badges, b]
}
function addVariant() {
  form.variants.push(emptyVariant())
}
function removeVariant(i: number) {
  form.variants.splice(i, 1)
}
function addAttr() {
  form.attrs.push({ k: '', v: '' })
}
function moveAttr(i: number, dir: number) {
  const j = i + dir
  if (j < 0 || j >= form.attrs.length) return
  const current = form.attrs[i]
  const target = form.attrs[j]
  if (!current || !target) return
  form.attrs[i] = target
  form.attrs[j] = current
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
      image: form.image || null,
      imageAlt: form.imageAlt || null,
      imageRightsOwner: form.imageRightsOwner || null,
      imageRightsLicense: form.imageRightsLicense || null,
      imageAuthorizedAt: form.imageAuthorizedAt || null,
      series: form.series || null,
      attrs: form.attrs.filter((a) => a.k.trim() && a.v.trim()),
      variants: form.variants.map((v) => ({
        ...(v.id != null ? { id: v.id } : {}),
        format: v.format,
        sku: v.sku || null,
        ean: v.ean || null,
        gtin: v.gtin || null,
        mpn: v.mpn || null,
        identifierExceptionReason: v.identifierExceptionReason || null,
        price: Number(v.price),
        stock: Number(v.stock),
        color: v.color || null,
        image: v.image || null,
        unitBase: v.unitBase,
        unitLabel: v.unitLabel,
        contentQuantity: Number(v.contentQuantity),
        unitsPerCase: Number(v.unitsPerCase),
        casesPerPallet: v.casesPerPallet == null ? null : Number(v.casesPerPallet),
        minimumQuantity: Number(v.minimumQuantity),
        quantityIncrement: Number(v.quantityIncrement),
        maximumQuantity: v.maximumQuantity == null ? null : Number(v.maximumQuantity),
        weightGrams: Number(v.weightGrams),
        widthMm: Number(v.widthMm),
        heightMm: Number(v.heightMm),
        depthMm: Number(v.depthMm),
        safetyStock: Number(v.safetyStock),
        backorderAllowed: v.backorderAllowed,
        leadTimeDays: v.leadTimeDays == null ? null : Number(v.leadTimeDays)
      }))
    }
    if (isNew) await $fetch('/api/admin/products', { method: 'POST', body: payload })
    else await $fetch(`/api/admin/products/${id}`, { method: 'PUT', body: payload })
    toast.add({ title: isNew ? 'Producto creado' : 'Cambios guardados', icon: 'i-lucide-check', color: 'success' })
    refreshNuxtData('categories')
    navigateTo('/admin/productos')
  } catch (error) {
    toast.add({
      title: apiErrorMessage(error, 'No se ha podido guardar'),
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
            <p class="text-sm text-slate-700">
              Estado editorial:
              <strong>{{ product?.status ?? 'draft' }}</strong
              >. Las transiciones y la publicación se realizan desde el listado para conservar auditoría y aplicar el
              gate completo.
            </p>
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

      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="font-bold text-slate-900">Imagen principal y derechos</h2>
        <p class="mt-1 text-sm text-slate-500">
          La publicación exige correspondencia exacta, texto alternativo y evidencia de licencia o autorización.
        </p>
        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <UFormField label="Ruta de la imagen" class="sm:col-span-2">
            <UInput v-model="form.image" class="w-full" placeholder="/media/uuid-del-asset-aprobado" />
          </UFormField>
          <UFormField label="Texto alternativo" class="sm:col-span-2">
            <UInput v-model="form.imageAlt" class="w-full" placeholder="Envase exacto y formato mostrado" />
          </UFormField>
          <UFormField label="Propietario / licenciante">
            <UInput v-model="form.imageRightsOwner" class="w-full" />
          </UFormField>
          <UFormField label="Licencia o autorización">
            <UInput v-model="form.imageRightsLicense" class="w-full" placeholder="Autorización proveedor, propia…" />
          </UFormField>
          <UFormField label="Fecha de autorización">
            <input
              v-model="form.imageAuthorizedAt"
              type="date"
              class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </UFormField>
        </div>
      </section>

      <!-- características técnicas -->
      <section class="rounded-2xl border border-slate-200 bg-white p-6">
        <div class="flex items-center justify-between">
          <h2 class="font-bold text-slate-900">Características técnicas</h2>
          <UButton size="sm" variant="soft" icon="i-lucide-plus" @click="addAttr">Añadir</UButton>
        </div>
        <p class="mt-1 text-sm text-slate-500">
          Salen en la tabla «Características» de la ficha, en este mismo orden: Material, Gramaje, Unidades/caja,
          Certificaciones, EAN…
        </p>
        <div v-if="form.attrs.length" class="mt-4 space-y-2">
          <div v-for="(a, i) in form.attrs" :key="i" class="grid grid-cols-[1fr_2fr_auto] items-center gap-2">
            <UInput v-model="a.k" placeholder="Material" />
            <UInput v-model="a.v" placeholder="Tejido sin tejer 55 g/m²" />
            <div class="flex gap-0.5">
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-chevron-up"
                :disabled="i === 0"
                aria-label="Subir"
                @click="moveAttr(i, -1)"
              />
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-chevron-down"
                :disabled="i === form.attrs.length - 1"
                aria-label="Bajar"
                @click="moveAttr(i, 1)"
              />
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                aria-label="Quitar"
                @click="form.attrs.splice(i, 1)"
              />
            </div>
          </div>
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
          <div v-for="(v, i) in form.variants" :key="i" class="rounded-xl border border-slate-200 p-4">
            <div class="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <UFormField label="Formato"
                ><UInput v-model="v.format" placeholder="Talla M · Garrafa 5 L…"
              /></UFormField>
              <UFormField label="Referencia ERP"><UInput v-model="v.sku" placeholder="1133" /></UFormField>
              <UFormField label="EAN"><UInput v-model="v.ean" inputmode="numeric" /></UFormField>
              <UFormField label="GTIN"><UInput v-model="v.gtin" inputmode="numeric" /></UFormField>
              <UFormField label="MPN fabricante"><UInput v-model="v.mpn" /></UFormField>
              <UButton
                size="sm"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                :disabled="form.variants.length <= 1"
                @click="removeVariant(i)"
                >Quitar</UButton
              >
            </div>
            <UFormField
              label="Excepción de identificador"
              hint="Obligatoria y motivada si no hay EAN, GTIN ni MPN"
              class="mt-3"
            >
              <UInput v-model="v.identifierExceptionReason" class="w-full" />
            </UFormField>
            <div class="mt-3 grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <UFormField label="Precio € IVA inc."
                ><input v-model.number="v.price" type="number" step="0.01" min="0" class="admin-number"
              /></UFormField>
              <UFormField label="Stock"
                ><input v-model.number="v.stock" type="number" min="0" class="admin-number"
              /></UFormField>
              <UFormField label="Stock seguridad"
                ><input v-model.number="v.safetyStock" type="number" min="0" class="admin-number"
              /></UFormField>
              <UFormField label="Unidad base"><UInput v-model="v.unitBase" placeholder="unit, l, kg" /></UFormField>
              <UFormField label="Etiqueta unidad"><UInput v-model="v.unitLabel" placeholder="unidad" /></UFormField>
              <UFormField label="Contenido"
                ><input
                  v-model.number="v.contentQuantity"
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  class="admin-number"
              /></UFormField>
            </div>
            <div class="mt-3 grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <UFormField label="MOQ"
                ><input v-model.number="v.minimumQuantity" type="number" min="1" class="admin-number"
              /></UFormField>
              <UFormField label="Incremento"
                ><input v-model.number="v.quantityIncrement" type="number" min="1" class="admin-number"
              /></UFormField>
              <UFormField label="Máximo"
                ><input v-model.number="v.maximumQuantity" type="number" min="1" class="admin-number"
              /></UFormField>
              <UFormField label="Uds./caja"
                ><input v-model.number="v.unitsPerCase" type="number" min="1" class="admin-number"
              /></UFormField>
              <UFormField label="Cajas/palé"
                ><input v-model.number="v.casesPerPallet" type="number" min="1" class="admin-number"
              /></UFormField>
              <UFormField label="Imagen variante"><UInput v-model="v.image" /></UFormField>
            </div>
            <div class="mt-3 grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <UFormField label="Peso g"
                ><input v-model.number="v.weightGrams" type="number" min="0" class="admin-number"
              /></UFormField>
              <UFormField label="Ancho mm"
                ><input v-model.number="v.widthMm" type="number" min="0" class="admin-number"
              /></UFormField>
              <UFormField label="Alto mm"
                ><input v-model.number="v.heightMm" type="number" min="0" class="admin-number"
              /></UFormField>
              <UFormField label="Fondo mm"
                ><input v-model.number="v.depthMm" type="number" min="0" class="admin-number"
              /></UFormField>
              <UFormField label="Color"><UInput v-model="v.color" placeholder="#f7c600" /></UFormField>
              <UFormField label="Lead time días"
                ><input v-model.number="v.leadTimeDays" type="number" min="0" class="admin-number"
              /></UFormField>
            </div>
            <label class="mt-3 flex items-center gap-2 text-sm text-slate-700"
              ><input v-model="v.backorderAllowed" type="checkbox" class="size-4" /> Permitir bajo pedido (requiere lead
              time)</label
            >
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

<style scoped>
.admin-number {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 0.5rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.875rem;
  line-height: 1.25rem;
}

.admin-number:focus {
  border-color: #169f62;
  outline: none;
}
</style>
