<script setup lang="ts">
import { useCartStore } from '~/stores/cart'

const route = useRoute()
const { data: product, error } = await useFetch<any>(`/api/products/${route.params.slug}`)
if (error.value || !product.value) {
  throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado', fatal: true })
}

useSeoMeta({
  title: product.value.name,
  description: product.value.shortDesc
})

const selectedId = ref<number>(product.value.variants[0]?.id)
const selected = computed(() =>
  product.value.variants.find((v: any) => v.id === selectedId.value) ?? product.value.variants[0]
)
const qty = ref(1)

// si todas las variantes tienen color propio (p. ej. mantelería), el selector son círculos de color.
// El formato admite ejes previos separados por « · », p. ej. «1,20 × 50 m · Precortado · Color Azul (AZ)»:
// cada eje se pinta como fila de píldoras en cascada (Medida → Acabado → colores), y cada rama
// puede ofrecer un surtido distinto. Etiqueta del eje: «Medida» si sus valores llevan números.
const parsedVariants = computed(() =>
  product.value.variants.map((v: any) => {
    const parts = String(v.format).split(' · ')
    const colorM = parts.at(-1)?.match(/^Color (.+)$/)
    return { v, axes: colorM ? parts.slice(0, -1) : [], colorName: colorM?.[1] ?? null }
  })
)
const colorMode = computed(
  () =>
    product.value.variants.length > 1 &&
    parsedVariants.value.every((p: any) => p.colorName && p.v.color) &&
    new Set(parsedVariants.value.map((p: any) => p.axes.length)).size === 1
)
const axisCount = computed(() => (colorMode.value ? parsedVariants.value[0].axes.length : 0))
const selectedParsed = computed(() => parsedVariants.value.find((p: any) => p.v.id === selectedId.value))

function axisOptions(level: number): string[] {
  const cur = selectedParsed.value?.axes ?? []
  const opts: string[] = []
  for (const p of parsedVariants.value) {
    if (p.axes.slice(0, level).every((a: string, i: number) => a === cur[i]) && !opts.includes(p.axes[level])) {
      opts.push(p.axes[level])
    }
  }
  return opts
}
function axisLabel(level: number): string {
  return axisOptions(level).some((o) => /\d/.test(o)) ? 'Medida' : 'Acabado'
}
function pickAxis(level: number, value: string) {
  const cur = selectedParsed.value
  if (!cur) return
  const prefix = [...cur.axes.slice(0, level), value]
  const cands = parsedVariants.value.filter((p: any) => prefix.every((a, i) => p.axes[i] === a))
  if (!cands.length) return
  const target =
    cands.find(
      (p: any) =>
        p.colorName === cur.colorName &&
        p.axes.join('|') === [...prefix, ...cur.axes.slice(level + 1)].join('|')
    ) ??
    cands.find((p: any) => p.colorName === cur.colorName) ??
    cands[0]
  selectedId.value = target.v.id
}
const colorOptions = computed(() => {
  const cur = selectedParsed.value
  if (!axisCount.value || !cur) return parsedVariants.value
  return parsedVariants.value.filter((p: any) => p.axes.join('|') === cur.axes.join('|'))
})
const mainImage = computed(() => selected.value?.image ?? product.value.image ?? null)

// precio informativo por unidad/litro/kilo del envase (estilo mayorista)
function perUnit(v: any): string | null {
  if (!v?.units || !v.unitLabel) return null
  const per = v.price / 100 / v.units
  const digits = per < 0.1 ? 3 : 2
  return `${per.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits })} €/${v.unitLabel}`
}

const cart = useCartStore()
const toast = useToast()

function addToCart(goToCart = false) {
  cart.add(
    {
      productId: product.value.id,
      slug: product.value.slug,
      name: product.value.name,
      brand: product.value.brand,
      variantId: selected.value.id,
      format: selected.value.format,
      sku: selected.value.sku,
      price: selected.value.price,
      visual: product.value.visual,
      image: selected.value.image ?? product.value.image ?? null
    },
    qty.value
  )
  if (goToCart) {
    navigateTo('/checkout')
  } else {
    toast.add({
      title: 'Añadido al carrito',
      description: `${product.value.name} · ${selected.value.format} × ${qty.value}`,
      icon: 'i-lucide-shopping-cart',
      color: 'success'
    })
  }
}
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-4 py-8 pb-24 lg:pb-8">
    <!-- migas -->
    <nav class="flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
      <NuxtLink to="/" class="hover:text-neteco-600">Inicio</NuxtLink>
      <template v-for="c in product.breadcrumb" :key="c.slug">
        <UIcon name="i-lucide-chevron-right" class="size-3.5" />
        <NuxtLink :to="`/categoria/${c.slug}`" class="hover:text-neteco-600">{{ c.name }}</NuxtLink>
      </template>
    </nav>

    <div class="mt-6 grid gap-8 lg:grid-cols-5">
      <!-- imagen -->
      <div class="relative self-start rounded-2xl border border-slate-200 bg-white p-6 sm:p-10 lg:col-span-2">
        <img
          v-if="mainImage"
          :src="mainImage"
          :alt="colorMode ? `${product.name} · ${selected.format}` : product.name"
          class="mx-auto aspect-square w-full max-w-[420px] rounded-xl bg-white object-contain"
        >
        <ProductVisual v-else :visual="product.visual" class="mx-auto max-w-[180px] sm:max-w-[260px]" />
        <div class="absolute left-6 top-6 flex flex-col items-start gap-1.5">
          <UBadge
            v-for="b in product.badges"
            :key="b"
            :color="BADGES[b]?.color ?? 'neutral'"
            :icon="BADGES[b]?.icon"
            variant="subtle"
          >
            {{ BADGES[b]?.label ?? b }}
          </UBadge>
        </div>
      </div>

      <!-- info y compra -->
      <div class="lg:col-span-3">
        <p
          v-if="product.brand && !product.name.toUpperCase().startsWith(product.brand.toUpperCase())"
          class="text-xs font-semibold uppercase tracking-widest text-neteco-600"
        >
          {{ product.brand }}
        </p>
        <h1 class="mt-1 text-2xl font-bold text-slate-900 sm:text-3xl">{{ product.name }}</h1>
        <p class="mt-3 text-slate-600">{{ product.shortDesc }}</p>

        <!-- selector de color (variantes con color propio; eje opcional de acabado) -->
        <div v-if="colorMode" class="mt-6 space-y-4">
          <div v-for="level in axisCount" :key="level">
            <p class="mb-2 text-sm font-semibold text-slate-700">{{ axisLabel(level - 1) }}</p>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="o in axisOptions(level - 1)"
                :key="o"
                :aria-pressed="selectedParsed?.axes[level - 1] === o"
                class="rounded-xl border-2 bg-white px-4 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500 focus-visible:ring-offset-2"
                :class="selectedParsed?.axes[level - 1] === o ? 'border-neteco-500 text-neteco-700 ring-1 ring-neteco-500' : 'border-slate-200 text-slate-700 hover:border-neteco-300'"
                @click="pickAxis(level - 1, o)"
              >
                {{ o }}
              </button>
            </div>
          </div>
          <div>
            <p class="mb-2.5 text-sm font-semibold text-slate-700">
              Color <span class="font-normal text-slate-500">({{ colorOptions.length }} disponibles)</span>
              <span class="font-normal text-slate-400"> · </span>
              <span class="text-neteco-700">{{ selectedParsed?.colorName }}</span>
            </p>
            <div class="flex flex-wrap gap-2.5">
              <button
                v-for="p in colorOptions"
                :key="p.v.id"
                :aria-pressed="selectedId === p.v.id"
                :aria-label="p.v.format"
                :title="p.colorName ?? p.v.format"
                class="size-9 rounded-full border border-black/15 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500 focus-visible:ring-offset-2"
                :class="selectedId === p.v.id ? 'ring-2 ring-neteco-500 ring-offset-2' : 'hover:scale-110'"
                :style="{ backgroundColor: p.v.color }"
                @click="selectedId = p.v.id"
              />
            </div>
            <p class="mt-2.5 font-mono text-xs text-slate-500">Ref. {{ selected.sku }}</p>
          </div>
        </div>

        <!-- formatos -->
        <div v-else class="mt-6">
          <p class="mb-2 text-sm font-semibold text-slate-700">
            Formato <span class="font-normal text-slate-500">({{ product.variants.length }} disponibles)</span>
          </p>
          <div class="space-y-2">
            <button
              v-for="v in product.variants"
              :key="v.id"
              :aria-pressed="selectedId === v.id"
              class="flex w-full items-center justify-between rounded-xl border-2 bg-white px-4 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500 focus-visible:ring-offset-2"
              :class="selectedId === v.id ? 'border-neteco-500 ring-1 ring-neteco-500' : 'border-slate-200 hover:border-neteco-300'"
              @click="selectedId = v.id"
            >
              <span>
                <span class="block font-medium text-slate-800">{{ v.format }}</span>
                <span class="block font-mono text-xs text-slate-500">Ref. {{ v.sku }}</span>
              </span>
              <span class="text-right">
                <span class="block font-display text-lg font-bold text-slate-900">{{ formatPrice(v.price) }}</span>
                <span v-if="perUnit(v)" class="block text-xs text-slate-500">{{ perUnit(v) }}</span>
              </span>
            </button>
          </div>
        </div>

        <!-- otros colores/versiones de la gama -->
        <div v-if="product.siblings?.length" class="mt-6">
          <p class="mb-2 text-sm font-semibold text-slate-700">Otros colores y versiones de la gama</p>
          <div class="flex flex-wrap gap-2">
            <NuxtLink
              v-for="s in product.siblings"
              :key="s.slug"
              :to="`/producto/${s.slug}`"
              class="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-neteco-300 hover:text-neteco-700"
            >
              <span class="size-3 shrink-0 rounded-full border border-black/10" :style="{ backgroundColor: s.visual?.color }" />
              {{ s.name }}
            </NuxtLink>
          </div>
        </div>

        <!-- cantidad + precio -->
        <div class="mt-6 flex flex-wrap items-center gap-4">
          <div class="flex items-center rounded-xl border border-slate-300">
            <button
              class="rounded-l-xl px-3.5 py-3 text-slate-500 hover:text-neteco-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500 disabled:opacity-30"
              :disabled="qty <= 1"
              aria-label="Menos unidades"
              @click="qty--"
            >
              <UIcon name="i-lucide-minus" class="block size-5" />
            </button>
            <span role="status" aria-label="Cantidad" class="w-10 text-center font-semibold">{{ qty }}</span>
            <button
              class="rounded-r-xl px-3.5 py-3 text-slate-500 hover:text-neteco-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
              aria-label="Más unidades"
              @click="qty++"
            >
              <UIcon name="i-lucide-plus" class="block size-5" />
            </button>
          </div>
          <div>
            <p class="font-display text-2xl font-bold text-slate-900">{{ formatPrice(selected.price * qty) }}</p>
            <p class="text-xs text-slate-500">
              IVA incluido<template v-if="perUnit(selected)"> · {{ perUnit(selected) }}</template>
            </p>
          </div>
          <p class="flex items-center gap-1.5 text-sm text-emerald-700">
            <span class="size-2 rounded-full bg-emerald-600" /> En stock
          </p>
        </div>

        <div class="mt-5 flex flex-col gap-3 sm:flex-row">
          <UButton size="xl" icon="i-lucide-shopping-cart" class="justify-center sm:flex-1" @click="addToCart(false)">
            Añadir al carrito
          </UButton>
          <UButton size="xl" variant="soft" icon="i-lucide-zap" class="justify-center" @click="addToCart(true)">
            Comprar ahora
          </UButton>
        </div>

        <div class="mt-6 grid gap-2 rounded-xl bg-slate-100 p-4 text-sm text-slate-600 sm:grid-cols-2">
          <p class="flex items-center gap-2"><UIcon name="i-lucide-truck" class="size-4 text-neteco-600" /> Reparto propio en Ontinyent y la Vall d'Albaida</p>
          <p class="flex items-center gap-2"><UIcon name="i-lucide-package-check" class="size-4 text-neteco-600" /> Envío península 48-72 h</p>
          <p class="flex items-center gap-2"><UIcon name="i-lucide-phone" class="size-4 text-neteco-600" /> Asesoramiento: 600 861 334</p>
          <p class="flex items-center gap-2"><UIcon name="i-lucide-badge-euro" class="size-4 text-neteco-600" /> Envío por agencia gratis a partir de 150 €</p>
        </div>
      </div>
    </div>

    <!-- descripción y detalles -->
    <div class="mt-10 grid items-start gap-8 lg:grid-cols-3">
      <div v-if="product.description || product.usage" class="rounded-2xl border border-slate-200 bg-white p-6 lg:col-span-2">
        <h2 class="text-lg font-bold text-slate-900">Descripción</h2>
        <p class="mt-3 leading-relaxed text-slate-600">{{ product.description }}</p>
        <template v-if="product.usage">
          <h3 class="mt-6 flex items-center gap-2 font-semibold text-slate-900">
            <UIcon name="i-lucide-beaker" class="size-4 text-neteco-600" /> Modo de empleo y dosificación
          </h3>
          <p class="mt-2 leading-relaxed text-slate-600">{{ product.usage }}</p>
        </template>
      </div>
      <div class="h-fit rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="text-lg font-bold text-slate-900">Características</h2>
        <dl class="mt-3 divide-y divide-slate-100 text-sm">
          <div v-if="product.brand" class="flex justify-between py-2"><dt class="text-slate-500">Marca</dt><dd class="font-medium text-slate-700">{{ product.brand }}</dd></div>
          <div class="flex justify-between py-2"><dt class="text-slate-500">Referencia</dt><dd class="font-mono font-medium text-slate-700">{{ selected.sku }}</dd></div>
          <div class="flex justify-between py-2"><dt class="text-slate-500">Formato</dt><dd class="font-medium text-slate-700">{{ selected.format }}</dd></div>
          <div v-if="selected.units && selected.unitLabel === 'ud'" class="flex justify-between py-2"><dt class="text-slate-500">Unidades por envase</dt><dd class="font-medium text-slate-700">{{ selected.units }}</dd></div>
          <div class="flex justify-between py-2"><dt class="text-slate-500">Categoría</dt><dd class="font-medium text-slate-700">{{ product.breadcrumb.at(-1)?.name }}</dd></div>
        </dl>
        <div class="mt-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
          <p class="flex items-center gap-1.5 font-medium text-slate-600">
            <UIcon name="i-lucide-file-text" class="size-4" /> Fichas técnicas y de seguridad
          </p>
          <UButton
            v-if="product.datasheet"
            :href="product.datasheet"
            target="_blank"
            variant="soft"
            size="sm"
            icon="i-lucide-file-down"
            class="mt-2"
          >
            Descargar ficha técnica (PDF)
          </UButton>
          <p v-else class="mt-1">Disponibles al importar el catálogo real (PDF por producto).</p>
        </div>
      </div>
    </div>

    <!-- relacionados -->
    <section v-if="product.related?.length" class="mt-12">
      <h2 class="mb-4 text-xl font-bold text-slate-900">También te puede interesar</h2>
      <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
        <ProductCard v-for="p in product.related" :key="p.id" :product="p" />
      </div>
    </section>

    <!-- barra de compra fija (móvil) -->
    <div
      class="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-slate-200 bg-white px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-4px_12px_rgba(15,23,42,0.06)] lg:hidden"
    >
      <div class="min-w-0">
        <p class="truncate text-xs text-slate-500">{{ selected.format }}</p>
        <p class="font-display text-lg font-bold text-slate-900">{{ formatPrice(selected.price * qty) }}</p>
      </div>
      <UButton size="lg" icon="i-lucide-shopping-cart" class="flex-1 justify-center" @click="addToCart(false)">
        Añadir al carrito
      </UButton>
    </div>
  </div>
</template>
