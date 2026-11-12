<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import { catalogPageFailureStatus } from '~~/shared/catalog-page-status'
import PromotionalBlocks from '~/components/PromotionalBlocks.vue'
import ProductEngagementPanel from '~/components/ProductEngagementPanel.vue'
import ProductVideoMediaGuide from '~/components/ProductVideoMediaGuide.vue'
import ProductGallery, { type GalleryImage } from '~/components/ProductGallery.vue'
import ProductInfoTabs, { type ProductInfoTab } from '~/components/ProductInfoTabs.vue'
import { buildAggregateRatingJsonLd, type ProductReviewSeoSummary } from '~~/shared/review-aggregate'
import ProductVerifiedReviewsQa from '~/components/ProductVerifiedReviewsQa.vue'
import VolumePricingTable from '~/components/VolumePricingTable.vue'
import { z } from 'zod'
import { dynamicOgMeta } from '~/utils/og-image'
import { ogVersion } from '~~/shared/og-image'
import { splitGross } from '~~/server/domain/money'
import { MAX_CART_QUANTITY } from '~~/shared/cart-limits'
import { productSafety, type ProductRegulatoryData } from '~~/shared/product-safety'
import { PRICE_ON_REQUEST, PRICE_REQUEST_ACTION, hasPublicPrice, priceRequestPath } from '~~/shared/price-on-request'
import type { ProductCardData, ProductVisualData, TypedAttributeDetail } from '~~/shared/types/catalog'

interface ProductVariant {
  uuid: string
  id: number
  format: string
  sku: string
  ean: string | null
  gtin: string | null
  mpn: string | null
  price: number
  compareAtPrice: number | null
  referencePrice30d: number | null
  priceTiers: Array<{ minimumQuantity: number; unitGrossCents: number }>
  pricingVersion: string
  netPrice: number
  taxRateBasisPoints: number
  stock: number
  units: number
  unitBase: string
  unitLabel: string
  unitsPerCase: number
  casesPerPallet: number | null
  minimumQuantity: number
  maximumQuantity: number | null
  quantityIncrement: number
  backorderAllowed: boolean
  leadTimeDays: number | null
  color: string | null
  image: string | null
  imageAlt?: string | null
}

interface ProductDetail {
  id: number
  name: string
  slug: string
  brand: string
  shortDesc: string | null
  description: string | null
  usage: string | null
  badges: string[]
  visual: ProductVisualData
  image: string | null
  imageAlt?: string | null
  /** Galería: todas las fotos publicadas del producto, la principal primero. */
  images?: Array<{ src: string; alt: string | null }>
  datasheet: string | null
  attrs: Array<{ k: string; v: string }>
  typedAttrs?: TypedAttributeDetail[]
  regulatory: ProductRegulatoryData
  variants: ProductVariant[]
  siblings: Array<{ name: string; slug: string; visual: ProductVisualData; image: string | null }>
  breadcrumb: Array<{ name: string; slug: string }>
  related: ProductCardData[]
  documents: Array<{
    id: string
    role: 'datasheet' | 'sds' | 'certificate' | 'label'
    name: string
    url: string
    version: string
    language: string | null
    authorizedAt: string | null
  }>
}

const route = useRoute()
const { ready, loggedIn, user, session } = useUserSession()
const { data: productData, error } = await useFetch<ProductDetail>(`/api/products/${route.params.slug}`)
const productFailure = catalogPageFailureStatus(error.value, productData.value)
if (productFailure) {
  if (productFailure === 503) useResponseHeader('Retry-After').value = '30'
  throw createError({
    statusCode: productFailure,
    statusMessage: productFailure === 404 ? 'Producto no encontrado' : 'Producto temporalmente no disponible',
    fatal: true
  })
}
if (!productData.value!.variants.length) {
  throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado', fatal: true })
}
const product = computed(() => productData.value!)
// SEO-026: la valoración agregada sale solo de opiniones propias verificadas y se muestra tal cual en la ficha
const { data: reviewSeo } = await useFetch<ProductReviewSeoSummary>(
  () => `/api/products/${product.value.id}/reviews/summary`,
  { key: `review-seo-${route.params.slug}` }
)
const aggregateRating = computed(() => (reviewSeo.value ? buildAggregateRatingJsonLd(reviewSeo.value) : null))
const reviewCount = computed(() => (aggregateRating.value ? (reviewSeo.value?.eligibleCount ?? 0) : 0))
const runtime = useRuntimeConfig()
const commercial = useCommercialTerms()
const governedMedia = Boolean(runtime.public.mediaGoverned)
const technicalDocuments = computed(() =>
  product.value.documents.filter((document) => !governedMedia || publishedDocumentUrl(document.url))
)
const datasheet = computed(() =>
  governedMedia ? publishedDocumentUrl(product.value.datasheet) : product.value.datasheet
)
const { net: showNetPrices } = usePriceDisplay()
const canonicalOrigin = String(runtime.public.baseUrl).replace(/\/$/, '')

const productSeoTitle = computed(() => formatSeoTitle(product.value.name))
const productSeoDescription = computed(() =>
  truncateSeoDescription(
    product.value.shortDesc ||
      product.value.description ||
      `Compra ${product.value.name} para uso profesional en la tienda online de NETECO.`
  )
)

// Tarjeta Open Graph dinámica (/og/producto/<slug>.png, generada en el Worker); si el runtime no la sirve se
// mantiene la imagen real del producto. `version` cambia con lo que dibuja la tarjeta e invalida CDN y redes.
const productOgMeta = computed(() =>
  dynamicOgMeta({
    origin: canonicalOrigin,
    kind: 'producto',
    slug: String(route.params.slug),
    version: ogVersion(
      product.value.name,
      product.value.brand,
      product.value.variants.length,
      Math.min(...product.value.variants.map((variant) => variant.price)),
      product.value.image
    ),
    alt: `${product.value.name} · NETECO`,
    dynamic: runtime.public.serverRuntime === 'cloudflare',
    fallbackImage: product.value.image
  })
)

useSeoMeta({
  title: () => productSeoTitle.value,
  description: () => productSeoDescription.value,
  ogTitle: () => `${productSeoTitle.value} · NETECO`,
  ogDescription: () => productSeoDescription.value,
  ogType: 'website',
  ogImage: () => productOgMeta.value.ogImage,
  ogImageWidth: () => productOgMeta.value.ogImageWidth,
  ogImageHeight: () => productOgMeta.value.ogImageHeight,
  ogImageType: () => productOgMeta.value.ogImageType,
  ogImageAlt: () => productOgMeta.value.ogImageAlt,
  twitterTitle: () => `${productSeoTitle.value} · NETECO`,
  twitterDescription: () => productSeoDescription.value,
  twitterImage: () => productOgMeta.value.twitterImage,
  twitterImageAlt: () => productOgMeta.value.twitterImageAlt
})

// La variante seleccionada vive en la URL (?sku=REF): el enlace es compartible
// y la selección sobrevive a recargas sin añadir entradas al historial.
const firstVariant = product.value.variants[0]!
const initialVariant = product.value.variants.find((variant) => variant.sku === String(route.query.sku ?? ''))
const selectedId = ref(initialVariant?.id ?? firstVariant.id)
const selected = computed(
  () => product.value.variants.find((variant) => variant.id === selectedId.value) ?? firstVariant
)
const engagementEnabled = computed(() => runtime.public.serverRuntime === 'cloudflare')
const engagementCustomerEnabled = computed(
  () =>
    engagementEnabled.value &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    z.string().uuid().safeParse(user.value?.id).success &&
    z.string().uuid().safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    Number(session.value?.sessionVersion) > 0
)
const engagementScope = computed(() =>
  JSON.stringify([
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion,
    product.value.id,
    selected.value.id
  ])
)
const { track } = useAnalytics()
const recentlyViewed = useRecentlyViewed()
onMounted(() => {
  void track('product_viewed', { productId: product.value.id, variantId: selected.value.id })
  recentlyViewed.record(product.value.slug)
})
/**
 * Cantidad por formato. Quien repone pide varios formatos a la vez, así que cada variante
 * tiene la suya y un solo botón las añade todas. El formato elegido empieza en su mínimo y
 * el resto en cero; mientras no se toque ninguna cantidad, elegir otro formato se lleva ese
 * punto de partida consigo, de modo que «elegir y añadir» sigue funcionando como siempre.
 */
const quantities = reactive<Record<number, number>>({})
const quantitiesTouched = ref(false)
function variantMaximum(variant: ProductVariant) {
  // Sin precio público el formato no se pide online: se pide su precio.
  if (!hasPublicPrice(variant.price)) return 0
  return Math.min(
    MAX_CART_QUANTITY,
    variant.maximumQuantity ?? Infinity,
    variant.backorderAllowed ? Infinity : variant.stock
  )
}
const variantOrderable = (variant: ProductVariant) =>
  variant.minimumQuantity <= MAX_CART_QUANTITY && variantMaximum(variant) >= variant.minimumQuantity
function startQuantities(focus: ProductVariant) {
  for (const variant of product.value.variants) quantities[variant.id] = 0
  if (variantOrderable(focus)) quantities[focus.id] = focus.minimumQuantity
  quantitiesTouched.value = false
}
startQuantities(initialVariant ?? firstVariant)
function setQuantity(variantId: number, value: number) {
  quantities[variantId] = value
  quantitiesTouched.value = true
}
/** Cantidad del formato elegido: la que rige su precio, su tramo y su entrega estimada. */
const qty = computed({
  get: () => Math.max(quantities[selected.value.id] ?? 0, selected.value.minimumQuantity),
  set: (value: number) => setQuantity(selected.value.id, value)
})
function priceForQuantity(variant: ProductVariant, quantity: number) {
  let price = variant.price
  for (const tier of variant.priceTiers) if (quantity >= tier.minimumQuantity) price = tier.unitGrossCents
  return price
}
const selectedUnitGrossPrice = computed(() => priceForQuantity(selected.value, qty.value))
const selectedUnitNetPrice = computed(
  () => splitGross(selectedUnitGrossPrice.value, selected.value.taxRateBasisPoints).netCents
)
const maximumQuantity = computed(() => variantMaximum(selected.value))

/** Lo que se va a añadir: cada formato con cantidad, a su precio por tramo. */
const orderLines = computed(() =>
  product.value.variants
    .filter((variant) => (quantities[variant.id] ?? 0) > 0 && variantOrderable(variant))
    .map((variant) => {
      const quantity = quantities[variant.id]!
      const unitGross = priceForQuantity(variant, quantity)
      return {
        variant,
        quantity,
        unitGross,
        gross: unitGross * quantity,
        net: splitGross(unitGross * quantity, variant.taxRateBasisPoints).netCents
      }
    })
)
const orderTotal = computed(() =>
  orderLines.value.reduce(
    (total, line) => ({
      units: total.units + line.quantity,
      gross: total.gross + line.gross,
      net: total.net + line.net
    }),
    { units: 0, gross: 0, net: 0 }
  )
)
/** «Se vende de 10 en 10»: solo se dice cuando el mínimo o el incremento no son uno. */
const sellingRule = computed(() => {
  const { minimumQuantity: minimum, quantityIncrement: increment } = selected.value
  if (minimum === 1 && increment === 1) return ''
  if (minimum === increment) return `Se vende de ${increment} en ${increment}.`
  return increment === 1
    ? `Pedido mínimo: ${minimum}.`
    : `Pedido mínimo: ${minimum}; después, de ${increment} en ${increment}.`
})
const outOfStock = computed(
  () =>
    selected.value.minimumQuantity > MAX_CART_QUANTITY ||
    (selected.value.stock < selected.value.minimumQuantity && !selected.value.backorderAllowed)
)
/** El formato elegido no tiene precio público: ni total, ni stock, ni «Añadir»; se pide el precio. */
const selectedOnRequest = computed(() => !hasPublicPrice(selected.value.price))
const requestOnly = computed(() => selectedOnRequest.value && !orderLines.value.length)
const priceRequestTo = computed(() =>
  priceRequestPath({
    slug: product.value.slug,
    name: product.value.name,
    sku: selected.value.sku,
    format: product.value.variants.length > 1 ? selected.value.format : null
  })
)
const availability = computed(() => {
  if (selected.value.minimumQuantity > MAX_CART_QUANTITY)
    return { label: 'No disponible para compra online', tone: 'unavailable' }
  if (selected.value.stock >= selected.value.minimumQuantity) {
    const lowThreshold = Math.max(selected.value.minimumQuantity * 3, 5)
    return selected.value.stock <= lowThreshold
      ? { label: `Quedan ${selected.value.stock}`, tone: 'warning' }
      : { label: 'En stock', tone: 'available' }
  }
  if (selected.value.backorderAllowed) {
    return {
      label: selected.value.leadTimeDays
        ? `Bajo pedido · plazo estimado ${selected.value.leadTimeDays} días`
        : 'Bajo pedido',
      tone: 'backorder'
    }
  }
  return { label: 'Agotado', tone: 'unavailable' }
})

/**
 * Días laborables antes de salir, para la fecha de entrega: 0 con stock para la cantidad
 * pedida; el plazo del proveedor si alguna línea va bajo pedido; `null` si va bajo pedido sin
 * plazo conocido (entonces no se promete fecha).
 */
const preparationDays = computed<number | null>(() => {
  const lines = orderLines.value.length
    ? orderLines.value.map((line) => ({ variant: line.variant, quantity: line.quantity }))
    : [{ variant: selected.value, quantity: qty.value }]
  let days = 0
  for (const { variant, quantity } of lines) {
    if (variant.stock >= quantity) continue
    if (!variant.backorderAllowed || variant.leadTimeDays === null) return null
    days = Math.max(days, variant.leadTimeDays)
  }
  return days
})

watch(selected, (variant) => {
  // Con selector de color solo se pide el color elegido. En la tabla de formatos las
  // cantidades son independientes: solo se mueve el punto de partida si nadie las ha tocado.
  if (colorMode.value || !quantitiesTouched.value) startQuantities(variant)
})

const router = useRouter()
watch(selected, (v) => {
  if (!v || product.value.variants.length < 2) return
  if (String(route.query.sku ?? '') !== String(v.sku)) {
    router.replace({ query: { ...route.query, sku: v.sku } })
  }
})

// canónica sin query: las 36 variantes son la misma página para los buscadores
const canonicalUrl = `${canonicalOrigin}/producto/${product.value.slug}`

// si todas las variantes tienen color propio (p. ej. mantelería), el selector son círculos de color.
// El formato admite ejes previos separados por « · », p. ej. «1,20 × 50 m · Precortado · Color Azul (AZ)»:
// cada eje se pinta como fila de píldoras en cascada (Medida → Acabado → colores), y cada rama
// puede ofrecer un surtido distinto. Etiqueta del eje: «Medida» si sus valores llevan números.
const parsedVariants = computed(() =>
  product.value.variants.map((variant) => {
    const parts = variant.format.split(' · ')
    const colorM = parts.at(-1)?.match(/^Color (.+)$/)
    return { v: variant, axes: colorM ? parts.slice(0, -1) : [], colorName: colorM?.[1] ?? null }
  })
)
const colorMode = computed(
  () =>
    product.value.variants.length > 1 &&
    parsedVariants.value.every((parsed) => parsed.colorName && parsed.v.color) &&
    new Set(parsedVariants.value.map((parsed) => parsed.axes.length)).size === 1
)
const axisCount = computed(() => (colorMode.value ? (parsedVariants.value[0]?.axes.length ?? 0) : 0))
const selectedParsed = computed(() => parsedVariants.value.find((parsed) => parsed.v.id === selectedId.value))

function axisOptions(level: number): string[] {
  const cur = selectedParsed.value?.axes ?? []
  const opts: string[] = []
  for (const p of parsedVariants.value) {
    const option = p.axes[level]
    if (option && p.axes.slice(0, level).every((axis, index) => axis === cur[index]) && !opts.includes(option)) {
      opts.push(option)
    }
  }
  return opts
}
function axisLabel(level: number): string {
  const opts = axisOptions(level)
  if (opts.some((o) => /precort/i.test(o))) return 'Precorte'
  if (opts.length && opts.every((o) => /\d/.test(o))) return 'Medida'
  return 'Acabado'
}
// la píldora muestra solo «Precortado»; el detalle «cada X cm» vive en Características
function axisDisplay(o: string): string {
  return /^precorte\s/i.test(o) ? 'Precortado' : o
}

// filas de Características derivadas de la selección (Medida / Precorte / Color con su muestra)
const selectedSpecs = computed(() => {
  if (!colorMode.value || !selectedParsed.value) return null
  const rows: Array<{ k: string; v: string; color?: string | null }> = []
  selectedParsed.value.axes.forEach((a: string, i: number) => {
    const label = axisLabel(i)
    const value =
      label === 'Precorte' && /^precorte\s+/i.test(a)
        ? a.replace(/^precorte\s+/i, '').replace(/^\p{L}/u, (c: string) => c.toUpperCase())
        : a
    rows.push({ k: label, v: value })
  })
  rows.push({
    k: 'Color',
    v: (selectedParsed.value.colorName ?? '').replace(/\s*\([^)]*\)$/, ''),
    color: selected.value?.color ?? null
  })
  return rows
})
function pickAxis(level: number, value: string) {
  const cur = selectedParsed.value
  if (!cur) return
  const prefix = [...cur.axes.slice(0, level), value]
  const cands = parsedVariants.value.filter((parsed) => prefix.every((axis, index) => parsed.axes[index] === axis))
  if (!cands.length) return
  const target =
    cands.find(
      (parsed) =>
        parsed.colorName === cur.colorName &&
        parsed.axes.join('|') === [...prefix, ...cur.axes.slice(level + 1)].join('|')
    ) ??
    cands.find((parsed) => parsed.colorName === cur.colorName) ??
    cands[0]
  if (!target) return
  selectedId.value = target.v.id
}
const colorOptions = computed(() => {
  const cur = selectedParsed.value
  if (!axisCount.value || !cur) return parsedVariants.value
  return parsedVariants.value.filter((parsed) => parsed.axes.join('|') === cur.axes.join('|'))
})

/**
 * Fotos de la galería: la del formato elegido primero y después las del producto (envase,
 * etiqueta, en uso). En productos por colores solo vale la foto del color elegido: nunca la de
 * otro color. Sin ninguna, la galería enseña la ilustración de familia.
 */
const galleryImages = computed<GalleryImage[]>(() => {
  const list: GalleryImage[] = []
  const push = (source: string | null | undefined, alt: string) => {
    const src = catalogImageSource(source, governedMedia)
    if (src && !list.some((image) => image.src === src)) list.push({ src, alt })
  }
  push(selected.value.image, selected.value.imageAlt || `${product.value.name} · ${selected.value.format}`)
  if (!colorMode.value) {
    push(product.value.image, product.value.imageAlt || product.value.name)
    for (const image of product.value.images ?? []) push(image.src, image.alt || product.value.name)
  }
  return list
})
// La URL que pinta la galería en grande; la precarga usa exactamente esta para no descargar dos veces.
const imgApi = useImage()
const fichaUrl = (src: string) =>
  publishedImageUrl(src, 1200, 'jpeg') ??
  (governedMedia ? '' : imgApi(src, { format: 'webp', quality: 85, width: 1200 }))

useHead(() => ({
  script: [
    {
      key: 'product-structured-data',
      type: 'application/ld+json',
      textContent: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Product',
        '@id': `${canonicalUrl}#product`,
        name: product.value.name,
        description: product.value.shortDesc ?? product.value.description ?? undefined,
        image: galleryImages.value.length
          ? galleryImages.value.map((image) => `${canonicalOrigin}${fichaUrl(image.src)}`)
          : undefined,
        sku: selected.value.sku,
        ...(selected.value.ean?.length === 8 ? { gtin8: selected.value.ean } : {}),
        ...(selected.value.ean?.length === 12 ? { gtin12: selected.value.ean } : {}),
        ...(selected.value.ean?.length === 13 ? { gtin13: selected.value.ean } : {}),
        ...(selected.value.gtin?.length === 14 ? { gtin14: selected.value.gtin } : {}),
        ...(selected.value.mpn ? { mpn: selected.value.mpn } : {}),
        brand: product.value.brand ? { '@type': 'Brand', name: product.value.brand } : undefined,
        ...(aggregateRating.value ? { aggregateRating: aggregateRating.value } : {}),
        // Una oferta a 0 € sería falsa: sin precio público no se publica oferta.
        ...(hasPublicPrice(selected.value.price)
          ? {
              offers: {
                '@type': 'Offer',
                url: `${canonicalUrl}?sku=${encodeURIComponent(selected.value.sku)}`,
                priceCurrency: 'EUR',
                price: (selected.value.price / 100).toFixed(2),
                availability: outOfStock.value ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
                itemCondition: 'https://schema.org/NewCondition'
              }
            }
          : {})
      }).replace(/</g, '\\u003c')
    },
    {
      key: 'product-breadcrumb-structured-data',
      type: 'application/ld+json',
      textContent: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Inicio', item: canonicalOrigin },
          ...product.value.breadcrumb.map((item, index) => ({
            '@type': 'ListItem',
            position: index + 2,
            name: item.name,
            item: `${canonicalOrigin}/categoria/${item.slug}`
          })),
          { '@type': 'ListItem', position: product.value.breadcrumb.length + 2, name: product.value.name }
        ]
      }).replace(/</g, '\\u003c')
    }
  ]
}))
// candidata LCP: precargar desde el HTML la foto grande inicial
useHead({
  link: () =>
    galleryImages.value[0] && fichaUrl(galleryImages.value[0].src)
      ? [{ rel: 'preload', as: 'image', href: fichaUrl(galleryImages.value[0].src) }]
      : []
})
// pre-descarga en segundo plano (en ratos libres del navegador) de todos los colores
// de la rama activa: pasar de un color a otro queda instantáneo, ya están en caché
const prefetched = new Set<string>()
const colorImageUrls = computed(() =>
  colorMode.value
    ? colorOptions.value
        .map((parsed) => catalogImageSource(parsed.v.image, governedMedia))
        .filter((source): source is string => Boolean(source))
        .map((source) => fichaUrl(source))
    : []
)
watch(
  colorImageUrls,
  (opts, _previous, onCleanup) => {
    if (!import.meta.client) return
    const urls = opts.filter((url) => url && !prefetched.has(url))
    if (!urls.length) return
    const go = () =>
      urls.forEach((u: string) => {
        prefetched.add(u)
        const im = new Image()
        im.src = u
      })
    if (typeof window.requestIdleCallback === 'function' && typeof window.cancelIdleCallback === 'function') {
      const id = window.requestIdleCallback(go, { timeout: 2000 })
      onCleanup(() => window.cancelIdleCallback(id))
    } else {
      const id = window.setTimeout(go, 400)
      onCleanup(() => window.clearTimeout(id))
    }
  },
  { immediate: true }
)

// precio informativo por unidad/litro/kilo del envase (estilo mayorista)
function perUnit(variant: ProductVariant, grossCents = variant.price): string | null {
  if (!variant.units || !variant.unitLabel) return null
  const per = grossCents / 100 / variant.units
  const digits = per < 0.1 ? 3 : 2
  return `${per.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits })} €/${variant.unitLabel}`
}

/** Precio por unidad del formato elegido, a la cantidad elegida (con su tramo). */
const unitPrice = computed(() => (showNetPrices.value ? selectedUnitNetPrice.value : selectedUnitGrossPrice.value))
/** Rebaja real: solo con precio anterior y referencia de 30 días publicados. */
const offer = computed(() => {
  const { compareAtPrice, referencePrice30d, price } = selected.value
  if (selectedOnRequest.value || !compareAtPrice || !referencePrice30d || compareAtPrice <= price) return null
  return { before: compareAtPrice, percent: Math.round(((compareAtPrice - price) / compareAtPrice) * 100) }
})

const cart = useCartStore()
const toast = useToast()
const adding = ref(false)

async function addFavorite() {
  if (!loggedIn.value) {
    await navigateTo(`/login?redirect=${encodeURIComponent(route.fullPath)}`)
    return
  }
  try {
    await $fetch('/api/account/favorites', {
      method: 'POST',
      body: { variantId: selected.value.uuid, quantity: qty.value }
    })
    toast.add({ title: 'Guardado en tu lista', icon: 'i-lucide-list-checks', color: 'success' })
  } catch {
    toast.add({ title: 'No se ha podido guardar', icon: 'i-lucide-triangle-alert', color: 'error' })
  }
}

/** Añade todas las líneas con cantidad. Devuelve si se han añadido todas (para «Comprados juntos»). */
async function addToCart(options: { silent?: boolean } = {}): Promise<boolean> {
  if (adding.value || !orderLines.value.length) return false
  adding.value = true
  const lines = [...orderLines.value]
  let current = lines[0]!
  try {
    for (const line of lines) {
      current = line
      await cart.add(
        {
          productId: product.value.id,
          slug: product.value.slug,
          name: product.value.name,
          brand: product.value.brand,
          variantId: line.variant.id,
          format: line.variant.format,
          sku: line.variant.sku,
          price: line.unitGross,
          netPrice: splitGross(line.unitGross, line.variant.taxRateBasisPoints).netCents,
          taxRateBasisPoints: line.variant.taxRateBasisPoints,
          visual: product.value.visual,
          image: line.variant.image ?? (colorMode.value ? null : product.value.image) ?? null
        },
        line.quantity
      )
    }
    if (!options.silent)
      toast.add({
        title: 'Añadido al carrito',
        description:
          lines.length === 1
            ? `${product.value.name} · ${current.variant.format} × ${current.quantity}`
            : `${product.value.name} · ${lines.length} formatos, ${orderTotal.value.units} uds`,
        icon: 'i-lucide-shopping-cart',
        color: 'success',
        actions: [{ label: 'Ver carrito', to: '/carrito' }]
      })
    return true
  } catch {
    toast.add({
      title: 'No se ha podido añadir',
      description: `${current.variant.format}: ${cart.error || 'actualiza la página y vuelve a intentarlo.'}`,
      icon: 'i-lucide-triangle-alert',
      color: 'error'
    })
    return false
  } finally {
    adding.value = false
  }
}

/**
 * Seguridad química. El menaje no lleva ningún bloque de peligros. En un químico, la ficha
 * enseña pictogramas, frases H y P y la FDS; los datos de transporte (ADR) completan lo que
 * falte en el producto, nunca lo sustituyen por un aviso genérico.
 */
interface HazardInfo {
  classified: boolean
  pictograms: string[]
  signalWord?: string | null
  hazardStatements: string[]
  precautionaryStatements: string[]
  ufiCode?: string | null
}
const hazardInfo = ref<HazardInfo | null>(null)
const baseSafety = computed(() => productSafety(product.value.regulatory, technicalDocuments.value))
const safety = computed(() => {
  const hazard = hazardInfo.value
  if (!hazard?.classified) return baseSafety.value
  const base = product.value.regulatory ?? {}
  return productSafety(
    {
      ...base,
      pictograms:
        (Array.isArray(base.pictograms) && base.pictograms.length ? base.pictograms : hazard.pictograms) ?? [],
      signalWord: base.signalWord ?? hazard.signalWord ?? undefined,
      hazardStatements:
        baseSafety.value.hazardStatements.length || !hazard.hazardStatements.length
          ? base.hazardStatements
          : hazard.hazardStatements,
      precautionaryStatements:
        baseSafety.value.precautionaryStatements.length || !hazard.precautionaryStatements.length
          ? base.precautionaryStatements
          : hazard.precautionaryStatements,
      ufi: base.ufi ?? hazard.ufiCode ?? undefined
    },
    technicalDocuments.value
  )
})
let hazardRequest = 0
watch(
  () => [selected.value.id, baseSafety.value.chemical] as const,
  async ([variantId, chemical]) => {
    const token = ++hazardRequest
    hazardInfo.value = null
    // Solo se consulta en químicos: un producto sin datos regulatorios no es «pendiente de verificar».
    if (!import.meta.client || !chemical || !engagementEnabled.value) return
    try {
      const data = await $fetch<HazardInfo>('/api/storefront/adr/hazard-info', {
        query: { variantId: String(variantId) }
      })
      if (token === hazardRequest) hazardInfo.value = data
    } catch {
      /* Sin datos de transporte se queda lo publicado en el producto. */
    }
  },
  { immediate: true }
)

const tabsRef = useTemplateRef<InstanceType<typeof ProductInfoTabs>>('tabs')
const infoTabs = computed<ProductInfoTab[]>(() => [
  { id: 'descripcion', label: 'Descripción' },
  { id: 'caracteristicas', label: 'Características' },
  { id: 'opiniones', label: 'Reseñas y preguntas', count: reviewCount.value || null },
  ...(safety.value.chemical ? [{ id: 'seguridad', label: 'Seguridad y fichas' }] : []),
  ...(engagementEnabled.value ? [{ id: 'avisos', label: 'Avisos y reposición' }] : []),
  { id: 'envio', label: 'Envío y devoluciones' }
])
const nonSafetyDocuments = computed(() =>
  safety.value.chemical ? [] : technicalDocuments.value.filter((document) => document.role !== 'sds')
)
const DOCUMENT_LABELS = {
  sds: 'Ficha de datos de seguridad',
  datasheet: 'Ficha técnica',
  label: 'Etiqueta',
  certificate: 'Certificado'
} as const

// Recomendaciones: una sola petición para «Comprados juntos» y las tres franjas.
const recommendations = useProductRecommendations({
  product: () => product.value.slug,
  strips: ['bought_together', 'also_viewed', 'for_you', 'trending'],
  limit: 10
})
const boughtTogether = recommendations.strip('bought_together')
const browseStrips = computed(() => recommendations.strips.value.filter((strip) => strip.kind !== 'bought_together'))
const fbtMain = computed(() =>
  orderLines.value.length && !requestOnly.value
    ? {
        name: product.value.name,
        image: galleryImages.value[0]?.src ?? null,
        visual: product.value.visual,
        grossCents: orderTotal.value.gross,
        netCents: orderTotal.value.net,
        detail:
          orderLines.value.length === 1
            ? `${orderLines.value[0]!.variant.format} × ${orderLines.value[0]!.quantity}`
            : `${orderLines.value.length} formatos, ${orderTotal.value.units} uds`,
        add: () => addToCart({ silent: true })
      }
    : null
)
</script>

<template>
  <div class="mx-auto max-w-[1440px] px-4 pb-28 pt-4 sm:px-6 lg:pb-12 lg:pt-6">
    <PromotionalBlocks
      :context="{
        placement: 'product',
        path: `/producto/${product.slug}`,
        productSlug: product.slug,
        categorySlug: product.breadcrumb.at(-1)?.slug
      }"
      class="mb-4"
    />
    <!-- Migas solo en escritorio: en el móvil la foto va arriba, sin rodeos. -->
    <nav
      aria-label="Migas de pan"
      class="hidden flex-wrap items-center gap-1.5 text-[13px] text-[var(--text-muted)] lg:flex"
    >
      <NuxtLink to="/" class="hover:text-[var(--link)] hover:underline">Inicio</NuxtLink>
      <template v-for="c in product.breadcrumb" :key="c.slug">
        <UIcon name="i-lucide-chevron-right" class="size-3.5" aria-hidden="true" />
        <NuxtLink :to="`/categoria/${c.slug}`" class="hover:text-[var(--link)] hover:underline">{{ c.name }}</NuxtLink>
      </template>
    </nav>

    <div class="grid grid-cols-1 items-start gap-x-8 gap-y-5 lg:mt-4 lg:grid-cols-12">
      <!-- Galería -->
      <div class="relative min-w-0 lg:col-span-6 lg:row-span-2 xl:col-span-5">
        <ProductGallery :images="galleryImages" :name="product.name" :context-key="selectedId">
          <template #empty>
            <!--
              Sin foto, la ilustración de familia dice el formato y el color, que ya es
              información. En B2B quien duda por no ver el producto llama y pregunta, así que
              se le ofrece la salida aquí.
            -->
            <div
              class="flex aspect-square w-full flex-col items-center justify-center rounded-[var(--radius-surface)] bg-[var(--surface)] px-6"
            >
              <ProductVisual :visual="product.visual" class="w-full max-w-[220px]" />
              <p class="mt-3 max-w-xs text-center text-[13px] text-[var(--text-muted)]">
                Todavía no tenemos foto de esta referencia.
                <NuxtLink
                  :to="
                    runtime.public.serverRuntime === 'cloudflare'
                      ? { path: '/contacto', query: { producto: product.slug } }
                      : '/contacto'
                  "
                  class="font-medium text-[var(--link)] underline underline-offset-2"
                >
                  Pídenosla
                </NuxtLink>
                y te la mandamos.
              </p>
            </div>
          </template>
        </ProductGallery>
        <div
          v-if="product.badges.length"
          class="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-1.5 lg:left-[88px]"
        >
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

      <!-- Nombre, precio, resumen y formatos -->
      <div class="min-w-0 lg:col-span-6 xl:col-span-4">
        <p
          v-if="product.brand && !product.name.toUpperCase().startsWith(product.brand.toUpperCase())"
          class="text-[13px] font-medium text-[var(--text-muted)]"
        >
          {{ product.brand }}
        </p>
        <h1 class="mt-0.5 text-2xl font-bold leading-tight text-[var(--text-strong)] lg:text-[28px]">
          {{ product.name }}
        </h1>
        <p class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[var(--text-muted)]">
          <span class="tabular">Ref. {{ selected.sku }}</span>
          <button
            v-if="reviewCount && reviewSeo"
            type="button"
            class="inline-flex min-h-6 items-center gap-1 text-[var(--link)] hover:underline"
            @click="tabsRef?.show('opiniones')"
          >
            <UIcon name="i-lucide-star" class="size-4 text-amber-600" aria-hidden="true" />
            {{ reviewSeo.averageRating.toFixed(1).replace('.', ',') }} · {{ reviewCount }}
            {{ reviewCount === 1 ? 'opinión' : 'opiniones' }}
          </button>
        </p>

        <!-- Precio del formato elegido: la cifra que decide, arriba y grande -->
        <div class="mt-3 border-y border-[var(--border)] py-3" data-product-price>
          <p v-if="selectedOnRequest" class="font-display text-[26px] font-bold text-[var(--text-strong)]">
            {{ PRICE_ON_REQUEST }}
          </p>
          <template v-else>
            <p class="flex flex-wrap items-baseline gap-x-2">
              <span v-if="offer" class="text-[15px] font-semibold text-[var(--price-offer)]"
                >−{{ offer.percent }} %</span
              >
              <span
                class="tabular font-display text-[26px] font-bold leading-none text-[var(--text-strong)] lg:text-[30px]"
              >
                {{ formatPrice(unitPrice) }}
              </span>
              <span class="text-[13px] font-medium text-[var(--text-muted)]">
                {{ showNetPrices ? 'sin IVA' : 'IVA incluido' }}
              </span>
            </p>
            <p class="tabular mt-1 text-[13px] text-[var(--text-muted)]">
              <template v-if="product.variants.length > 1">{{ selected.format }} · </template>
              {{ formatPrice(showNetPrices ? selectedUnitGrossPrice : selectedUnitNetPrice) }}
              {{ showNetPrices ? 'con IVA' : 'sin IVA' }}
              <template v-if="perUnit(selected, unitPrice)"> · {{ perUnit(selected, unitPrice) }}</template>
            </p>
            <p v-if="offer && selected.referencePrice30d" class="mt-1 text-[13px] text-[var(--text-muted)]">
              Antes <s>{{ formatPrice(offer.before) }}</s> · Precio más bajo de los 30 días anteriores:
              {{ formatPrice(selected.referencePrice30d) }}
            </p>
          </template>
        </div>

        <p v-if="product.shortDesc" class="mt-3 text-[15px] leading-relaxed text-[var(--text)]">
          {{ product.shortDesc }}
        </p>

        <!-- Seguridad junto a la compra, solo en químicos -->
        <div
          v-if="safety.chemical"
          class="mt-4 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] p-3"
        >
          <ProductSafetyPanel
            :safety="safety"
            :product-slug="product.slug"
            summary
            @details="tabsRef?.show('seguridad')"
          />
        </div>

        <!-- selector de color (variantes con color propio; eje opcional de acabado) -->
        <div v-if="colorMode" class="mt-5 space-y-4">
          <div v-for="level in axisCount" :key="level">
            <p class="mb-2 text-[15px] font-semibold text-[var(--text-strong)]">{{ axisLabel(level - 1) }}</p>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="o in axisOptions(level - 1)"
                :key="o"
                type="button"
                :aria-pressed="selectedParsed?.axes[level - 1] === o"
                class="min-h-11 rounded-[var(--radius-control)] border-2 bg-white px-4 text-[15px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--action)] focus-visible:ring-offset-2"
                :class="
                  selectedParsed?.axes[level - 1] === o
                    ? 'border-[var(--action)] text-[var(--text-strong)]'
                    : 'border-[var(--border)] text-[var(--text)] hover:border-[var(--border-strong)]'
                "
                @click="pickAxis(level - 1, o)"
              >
                {{ axisDisplay(o) }}
              </button>
            </div>
          </div>
          <div>
            <p class="mb-2.5 text-[15px] font-semibold text-[var(--text-strong)]">
              Color <span class="font-normal text-[var(--text-muted)]">({{ colorOptions.length }} disponibles)</span>
              ·
              <span class="font-normal">{{ selectedParsed?.colorName }}</span>
            </p>
            <div class="flex flex-wrap gap-2.5">
              <button
                v-for="p in colorOptions"
                :key="p.v.id"
                type="button"
                :aria-pressed="selectedId === p.v.id"
                :aria-label="p.v.format"
                :title="p.colorName ?? p.v.format"
                class="size-11 rounded-full border border-black/15 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--action)] focus-visible:ring-offset-2"
                :class="selectedId === p.v.id ? 'ring-2 ring-[var(--action)] ring-offset-2' : 'hover:scale-105'"
                :style="{ backgroundColor: p.v.color ?? '#94a3b8' }"
                @click="selectedId = p.v.id"
              />
            </div>
          </div>
        </div>

        <!-- formatos -->
        <div v-else-if="product.variants.length > 1" class="mt-5">
          <p class="mb-2 text-[15px] font-semibold text-[var(--text-strong)]">Elige formato y cantidad</p>
          <VariantOrderTable
            v-model="selectedId"
            :variants="product.variants"
            :quantities="quantities"
            :maximum="(variant) => (Number.isFinite(variantMaximum(variant)) ? variantMaximum(variant) : null)"
            :without-quantity="(variant) => !hasPublicPrice(variant.price)"
            @quantity="setQuantity"
          >
            <template #default="{ variant: v }">
              <span class="min-w-0">
                <span class="block font-medium text-[var(--text-strong)]">{{ v.format }}</span>
                <span class="tabular block text-[13px] text-[var(--text-muted)]">Ref. {{ v.sku }}</span>
                <span
                  v-if="hasPublicPrice(v.price)"
                  class="mt-0.5 flex items-center gap-1 text-[13px] font-medium"
                  :class="variantAvailability(v).tone"
                >
                  <UIcon :name="variantAvailability(v).icon" class="size-3.5 shrink-0" />
                  {{ variantAvailability(v).label }}
                </span>
              </span>
              <span v-if="!hasPublicPrice(v.price)" data-price-on-request class="text-right">
                <span class="block font-display text-[15px] font-bold text-[var(--text-strong)]">
                  {{ PRICE_ON_REQUEST }}
                </span>
              </span>
              <span v-else class="text-right">
                <span class="tabular block font-display text-lg font-bold text-[var(--text-strong)]">
                  {{ formatPrice(showNetPrices ? v.netPrice : v.price) }}
                </span>
                <span class="tabular block text-[13px] text-[var(--text-muted)]">
                  {{ showNetPrices ? 'sin IVA' : 'IVA incluido'
                  }}<template v-if="perUnit(v, showNetPrices ? v.netPrice : v.price)">
                    · {{ perUnit(v, showNetPrices ? v.netPrice : v.price) }}</template
                  >
                </span>
              </span>
            </template>
          </VariantOrderTable>
        </div>

        <!-- otros colores/versiones de la gama -->
        <div v-if="product.siblings?.length" class="mt-5">
          <p class="mb-2 text-[15px] font-semibold text-[var(--text-strong)]">Otros colores y versiones de la gama</p>
          <div class="flex flex-wrap gap-2">
            <NuxtLink
              v-for="s in product.siblings"
              :key="s.slug"
              :to="`/producto/${s.slug}`"
              class="flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 text-[15px] font-medium text-[var(--text)] transition hover:border-[var(--border-strong)]"
            >
              <span
                class="size-3 shrink-0 rounded-full border border-black/10"
                :style="{ backgroundColor: s.visual?.color }"
              />
              {{ s.name }}
            </NuxtLink>
          </div>
        </div>
      </div>

      <!-- Caja de compra: precio, entrega, cantidad y acción juntos. Fija al bajar en escritorio. -->
      <aside
        class="min-w-0 lg:col-span-6 lg:col-start-7 xl:col-span-3 xl:col-start-auto xl:row-span-2 xl:row-start-1"
        aria-label="Compra"
      >
        <div
          data-buy-box
          class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 xl:sticky xl:top-24"
        >
          <div v-if="requestOnly" data-order-summary data-price-on-request>
            <p class="font-display text-[26px] font-bold leading-tight text-[var(--text-strong)]">
              {{ PRICE_ON_REQUEST }}
            </p>
            <p class="tabular mt-1 text-[13px] font-medium text-[var(--text-muted)]">Ref. {{ selected.sku }}</p>
            <p v-if="sellingRule" class="mt-1 text-[13px] text-[var(--text-muted)]">{{ sellingRule }}</p>
          </div>
          <div v-else data-order-summary>
            <p class="text-[13px] font-medium text-[var(--text-muted)]">
              <template v-if="orderTotal.units">
                Total · {{ orderTotal.units }} {{ orderTotal.units === 1 ? 'ud' : 'uds'
                }}<template v-if="orderLines.length > 1"> · {{ orderLines.length }} formatos</template>
              </template>
              <template v-else>Indica una cantidad</template>
            </p>
            <p
              data-order-total
              class="tabular font-display text-[26px] font-bold leading-tight text-[var(--text-strong)] lg:text-[30px]"
            >
              {{ formatPrice(showNetPrices ? orderTotal.net : orderTotal.gross) }}
              <span class="font-sans text-[13px] font-medium text-[var(--text-muted)]">
                {{ showNetPrices ? 'sin IVA' : 'IVA incluido' }}
              </span>
            </p>
            <p class="tabular text-[13px] text-[var(--text-muted)]">
              {{ formatPrice(showNetPrices ? orderTotal.gross : orderTotal.net) }}
              {{ showNetPrices ? 'con IVA' : 'sin IVA' }} ({{ selected.taxRateBasisPoints / 100 }} %)
            </p>
          </div>

          <!-- Fecha de entrega concreta, en verde y negrita: la duda nº 1 de quien repone -->
          <div v-if="!requestOnly && !outOfStock" class="mt-4">
            <DeliveryPromiseLine :preparation-days="preparationDays" />
          </div>

          <p
            v-if="!requestOnly && orderLines.length <= 1"
            data-availability
            class="mt-3 flex items-center gap-1.5 text-[15px] font-semibold"
            :class="
              availability.tone === 'unavailable'
                ? 'text-[var(--stock-out)]'
                : availability.tone === 'warning' || availability.tone === 'backorder'
                  ? 'text-[var(--stock-low)]'
                  : 'text-[var(--stock-ok)]'
            "
          >
            <UIcon
              :name="
                availability.tone === 'unavailable'
                  ? 'i-lucide-circle-x'
                  : availability.tone === 'warning'
                    ? 'i-lucide-circle-alert'
                    : availability.tone === 'backorder'
                      ? 'i-lucide-clock'
                      : 'i-lucide-circle-check'
              "
              class="size-4 shrink-0"
            />
            {{ availability.label }}
          </p>
          <p v-if="sellingRule && !requestOnly" class="mt-1 text-[13px] text-[var(--text-muted)]">{{ sellingRule }}</p>

          <!-- Cantidad: en la tabla de formatos cada fila lleva la suya; aquí, con un solo formato o con colores -->
          <div
            v-if="!requestOnly && (colorMode || product.variants.length === 1)"
            class="mt-4 flex items-center justify-between gap-3"
          >
            <span class="text-[15px] font-semibold text-[var(--text-strong)]">Cantidad</span>
            <QuantityStepper
              v-model="qty"
              :minimum="selected.minimumQuantity"
              :maximum="Number.isFinite(maximumQuantity) ? maximumQuantity : null"
              :step="selected.quantityIncrement"
              label="Cantidad"
              :disabled="outOfStock || selectedOnRequest"
            />
          </div>

          <VolumePricingTable
            v-if="!selectedOnRequest && selected.priceTiers.length"
            class="mt-4"
            :base-gross-cents="selected.price"
            :tax-rate-basis-points="selected.taxRateBasisPoints"
            :tiers="selected.priceTiers"
            :current-quantity="qty"
            :show-net-prices="showNetPrices"
          />

          <!-- Una sola acción principal; «Guardar en lista» lleva su texto, no un corazón suelto. -->
          <div class="mt-5 flex flex-col gap-2">
            <NuxtLink
              v-if="requestOnly"
              :to="priceRequestTo"
              data-price-request
              class="inline-flex h-12 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--action)] px-5 font-semibold text-white transition-colors hover:bg-[var(--action-hover)]"
            >
              <UIcon name="i-lucide-message-circle" class="size-5" />{{ PRICE_REQUEST_ACTION }}
            </NuxtLink>
            <button
              v-else
              type="button"
              data-add-to-cart
              :disabled="!orderLines.length || adding"
              class="inline-flex h-12 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--action)] px-5 font-semibold text-white transition-colors hover:bg-[var(--action-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              @click="addToCart()"
            >
              <UIcon name="i-lucide-shopping-cart" class="size-5" />Añadir al carrito
            </button>
            <UButton
              data-save-to-list
              size="lg"
              color="neutral"
              variant="outline"
              icon="i-lucide-list-plus"
              class="justify-center"
              @click="addFavorite"
            >
              Guardar en lista
            </UButton>
          </div>

          <ul class="mt-5 space-y-2 border-t border-[var(--border)] pt-4 text-[13px] text-[var(--text-muted)]">
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-receipt-text" class="mt-px size-4 shrink-0" aria-hidden="true" />
              Factura con tus datos fiscales en cada pedido.
            </li>
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-undo-2" class="mt-px size-4 shrink-0" aria-hidden="true" />
              <span>
                <NuxtLink to="/devoluciones" class="underline underline-offset-2 hover:text-[var(--link)]">
                  Devoluciones
                </NuxtLink>
                y
                <NuxtLink to="/envios" class="underline underline-offset-2 hover:text-[var(--link)]">envíos</NuxtLink>
              </span>
            </li>
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-phone" class="mt-px size-4 shrink-0" aria-hidden="true" />
              <span>Asesoramiento: <ContactAction link-class="underline" /></span>
            </li>
          </ul>
        </div>
      </aside>
    </div>

    <!-- Comprados juntos frecuentemente -->
    <FrequentlyBoughtTogether v-if="boughtTogether" :strip="boughtTogether" :main="fbtMain" class="mt-10" />

    <!-- Información en pestañas (escritorio) y acordeón (móvil) -->
    <ProductInfoTabs ref="tabs" :tabs="infoTabs" class="mt-10">
      <template #descripcion>
        <div class="max-w-3xl">
          <p v-if="product.description" class="whitespace-pre-line text-[15px] leading-relaxed text-[var(--text)]">
            {{ product.description }}
          </p>
          <p v-else-if="product.shortDesc" class="text-[15px] leading-relaxed text-[var(--text)]">
            {{ product.shortDesc }}
          </p>
          <template v-if="product.usage">
            <h3 class="mt-6 flex items-center gap-2 text-[15px] font-semibold text-[var(--text-strong)]">
              <UIcon name="i-lucide-beaker" class="size-4 text-[var(--text-muted)]" aria-hidden="true" /> Modo de empleo
              y dosificación
            </h3>
            <p class="mt-2 whitespace-pre-line text-[15px] leading-relaxed text-[var(--text)]">{{ product.usage }}</p>
          </template>
        </div>
        <!-- Guía de vídeo, dosificación y montaje (MED-016 y PDP-018) -->
        <ProductVideoMediaGuide :product-id="product.id" class="mt-6" />
      </template>

      <template #caracteristicas>
        <dl
          class="text-[15px] sm:columns-2 sm:gap-x-10 [&>div]:break-inside-avoid [&>div]:border-b [&>div]:border-[var(--border)]"
        >
          <div v-if="product.brand" class="flex justify-between gap-4 py-2">
            <dt class="text-[var(--text-muted)]">Marca</dt>
            <dd class="font-medium text-[var(--text-strong)]">{{ product.brand }}</dd>
          </div>
          <div class="flex justify-between gap-4 py-2">
            <dt class="text-[var(--text-muted)]">Referencia</dt>
            <dd class="tabular font-medium text-[var(--text-strong)]">{{ selected.sku }}</dd>
          </div>
          <div v-if="selected.ean || selected.gtin || selected.mpn" class="flex justify-between gap-4 py-2">
            <dt class="text-[var(--text-muted)]">EAN / GTIN / MPN</dt>
            <dd class="tabular text-right font-medium text-[var(--text-strong)]">
              {{ selected.ean || selected.gtin || selected.mpn }}
            </dd>
          </div>
          <template v-if="selectedSpecs">
            <div v-for="(s, index) in selectedSpecs" :key="`${s.k}-${index}`" class="flex justify-between gap-4 py-2">
              <dt class="shrink-0 text-[var(--text-muted)]">{{ s.k }}</dt>
              <dd class="flex items-center justify-end gap-1.5 text-right font-medium text-[var(--text-strong)]">
                <span
                  v-if="s.color"
                  class="size-3.5 shrink-0 rounded-full border border-black/15"
                  :style="{ backgroundColor: s.color }"
                />
                {{ s.v }}
              </dd>
            </div>
          </template>
          <div v-else class="flex justify-between gap-4 py-2">
            <dt class="text-[var(--text-muted)]">Formato</dt>
            <dd class="text-right font-medium text-[var(--text-strong)]">{{ selected.format }}</dd>
          </div>
          <div v-if="selected.units && selected.unitLabel === 'ud'" class="flex justify-between gap-4 py-2">
            <dt class="text-[var(--text-muted)]">Unidades por envase</dt>
            <dd class="font-medium text-[var(--text-strong)]">{{ selected.units }}</dd>
          </div>
          <div v-if="sellingRule" class="flex justify-between gap-4 py-2">
            <dt class="text-[var(--text-muted)]">Venta</dt>
            <dd class="text-right font-medium text-[var(--text-strong)]">{{ sellingRule }}</dd>
          </div>
          <div v-if="selected.unitsPerCase > 1" class="flex justify-between gap-4 py-2">
            <dt class="text-[var(--text-muted)]">Unidades por caja</dt>
            <dd class="font-medium text-[var(--text-strong)]">{{ selected.unitsPerCase }}</dd>
          </div>
          <div v-if="selected.casesPerPallet" class="flex justify-between gap-4 py-2">
            <dt class="text-[var(--text-muted)]">Cajas por palé</dt>
            <dd class="font-medium text-[var(--text-strong)]">{{ selected.casesPerPallet }}</dd>
          </div>
          <div v-for="attribute in product.attrs" :key="attribute.k" class="flex justify-between gap-4 py-2">
            <dt class="shrink-0 text-[var(--text-muted)]">{{ attribute.k }}</dt>
            <dd class="text-right font-medium text-[var(--text-strong)]">{{ attribute.v }}</dd>
          </div>
          <div
            v-for="attribute in product.typedAttrs ?? []"
            :key="`${attribute.definitionId}:${attribute.revision}`"
            :data-typed-detail="attribute.definitionId"
            class="flex min-w-0 justify-between gap-4 py-2"
          >
            <dt class="min-w-0 break-words text-[var(--text-muted)]">{{ attribute.label }}</dt>
            <dd class="min-w-0 break-words text-right font-medium text-[var(--text-strong)]">
              {{ attribute.displayValue }}
            </dd>
          </div>
          <div class="flex justify-between gap-4 py-2">
            <dt class="text-[var(--text-muted)]">Categoría</dt>
            <dd class="text-right font-medium text-[var(--text-strong)]">{{ product.breadcrumb.at(-1)?.name }}</dd>
          </div>
        </dl>
        <ul v-if="nonSafetyDocuments.length" data-product-documents class="mt-5 flex flex-wrap gap-2">
          <li v-for="document in nonSafetyDocuments" :key="`${document.id}-${document.role}-${document.version}`">
            <a
              :href="document.url"
              target="_blank"
              rel="noopener"
              class="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-[15px] font-medium text-[var(--text-strong)] hover:border-[var(--action)] hover:text-[var(--action)]"
            >
              <UIcon name="i-lucide-file-down" class="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              {{ DOCUMENT_LABELS[document.role] }}
              <span class="text-[13px] font-normal text-[var(--text-muted)]">PDF · v{{ document.version }}</span>
            </a>
          </li>
        </ul>
        <UButton
          v-else-if="datasheet && !safety.chemical && runtime.public.appEnv !== 'production'"
          :href="datasheet"
          target="_blank"
          variant="outline"
          color="neutral"
          icon="i-lucide-file-down"
          class="mt-5"
        >
          Descargar ficha técnica (PDF)
        </UButton>
      </template>

      <template #opiniones>
        <!-- Reviews verificadas y Q&A moderado (PDP-016) -->
        <div v-if="reviewSeo" class="mb-4" aria-label="Valoración de clientes" data-testid="review-aggregate">
          <p v-if="aggregateRating" class="text-[15px] text-[var(--text-strong)]">
            <strong>{{ reviewSeo.averageRating.toFixed(1).replace('.', ',') }} / 5</strong>
            · {{ reviewSeo.eligibleCount }} opiniones de compradores verificados
          </p>
          <p class="text-[13px] text-[var(--text-muted)]">{{ reviewSeo.policy.text }}</p>
        </div>
        <ProductVerifiedReviewsQa :product-id="product.id" :product-name="product.name" />
      </template>

      <template v-if="safety.chemical" #seguridad>
        <ProductSafetyPanel :safety="safety" :product-slug="product.slug" />
      </template>

      <template v-if="engagementEnabled" #avisos>
        <ProductEngagementPanel
          :product-id="product.id"
          :variant-id="selected.id"
          :scope-key="engagementScope"
          :enabled="engagementEnabled"
          :customer-enabled="engagementCustomerEnabled"
        />
      </template>

      <template #envio>
        <div class="max-w-3xl space-y-4 text-[15px] leading-relaxed text-[var(--text)]">
          <DeliveryPromiseLine v-if="!requestOnly && !outOfStock" :preparation-days="preparationDays" />
          <p class="flex items-start gap-2">
            <UIcon name="i-lucide-truck" class="mt-1 size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            {{ commercial.ownDelivery.value.text }}
          </p>
          <p v-if="commercial.parcel.value" class="flex items-start gap-2">
            <UIcon
              name="i-lucide-package-check"
              class="mt-1 size-4 shrink-0 text-[var(--text-muted)]"
              aria-hidden="true"
            />
            {{ commercial.parcel.value.text }}
          </p>
          <p class="flex items-start gap-2">
            <UIcon name="i-lucide-undo-2" class="mt-1 size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            <span>
              Condiciones de cambio y devolución en
              <NuxtLink to="/devoluciones" class="font-medium text-[var(--link)] underline underline-offset-2">
                Devoluciones</NuxtLink
              >. Plazos y costes por zona en
              <NuxtLink to="/envios" class="font-medium text-[var(--link)] underline underline-offset-2"
                >Envíos</NuxtLink
              >.
            </span>
          </p>
        </div>
      </template>
    </ProductInfoTabs>

    <!-- Recomendaciones: tres franjas en escritorio, una en móvil -->
    <RecommendationStrips
      v-if="recommendations.available"
      :strips="browseStrips"
      :loading="recommendations.state.value === 'loading' || recommendations.state.value === 'idle'"
      :placeholders="0"
      :mobile-count="1"
      class="mt-12"
    />
    <section v-else-if="product.related?.length" class="mt-12">
      <h2 class="mb-4 text-lg font-bold text-[var(--text-strong)] lg:text-[22px]">Más productos de esta familia</h2>
      <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
        <ProductCard v-for="p in product.related" :key="p.id" :product="p" />
      </div>
    </section>

    <!-- barra de compra fija (móvil): total, fecha y la misma acción que la caja de compra -->
    <div
      data-mobile-buy-bar
      class="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[var(--shadow-overlay)] lg:hidden"
    >
      <div v-if="requestOnly" class="min-w-0">
        <p class="truncate text-[13px] text-[var(--text-muted)]">Ref. {{ selected.sku }}</p>
        <p class="font-display text-lg font-bold text-[var(--text-strong)]">{{ PRICE_ON_REQUEST }}</p>
      </div>
      <div v-else class="min-w-0">
        <p class="truncate text-[13px] text-[var(--text-muted)]">
          <template v-if="orderTotal.units">
            {{ orderTotal.units }} {{ orderTotal.units === 1 ? 'ud' : 'uds' }} ·
            {{ showNetPrices ? 'sin IVA' : 'IVA incluido' }}
          </template>
          <template v-else>Indica una cantidad</template>
        </p>
        <p class="tabular font-display text-lg font-bold text-[var(--text-strong)]">
          {{ formatPrice(showNetPrices ? orderTotal.net : orderTotal.gross) }}
        </p>
      </div>
      <NuxtLink
        v-if="requestOnly"
        :to="priceRequestTo"
        data-price-request
        class="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--action)] px-4 font-semibold text-white transition-colors hover:bg-[var(--action-hover)]"
      >
        <UIcon name="i-lucide-message-circle" class="size-5" />{{ PRICE_REQUEST_ACTION }}
      </NuxtLink>
      <button
        v-else
        type="button"
        :disabled="!orderLines.length || adding"
        class="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--action)] px-4 font-semibold text-white transition-colors hover:bg-[var(--action-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        @click="addToCart()"
      >
        <UIcon name="i-lucide-shopping-cart" class="size-5" />Añadir al carrito
      </button>
    </div>
  </div>
</template>
