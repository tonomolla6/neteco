<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import PublishedProductRelations from '~/components/PublishedProductRelations.vue'
import ProductDetailExtras from '~/components/ProductDetailExtras.vue'
import PromotionalBlocks from '~/components/PromotionalBlocks.vue'
import ProductImageLightbox from '~/components/ProductImageLightbox.vue'
import ProductEngagementPanel from '~/components/ProductEngagementPanel.vue'
import ProductVideoMediaGuide from '~/components/ProductVideoMediaGuide.vue'
import { buildAggregateRatingJsonLd, type ProductReviewSeoSummary } from '~~/shared/review-aggregate'
import ProductVerifiedReviewsQa from '~/components/ProductVerifiedReviewsQa.vue'
import VolumePricingTable from '~/components/VolumePricingTable.vue'
import { z } from 'zod'
import { dynamicOgMeta } from '~/utils/og-image'
import { ogVersion } from '~~/shared/og-image'
import { splitGross } from '~~/server/domain/money'
import { MAX_CART_QUANTITY } from '~~/shared/cart-limits'
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
  datasheet: string | null
  attrs: Array<{ k: string; v: string }>
  typedAttrs?: TypedAttributeDetail[]
  regulatory: {
    signalWord?: string
    ufi?: string
    registrationNumber?: string
    hazardStatements?: string[]
    precautionaryStatements?: string[]
  }
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
if (error.value || !productData.value || !productData.value.variants.length) {
  throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado', fatal: true })
}
const product = computed(() => productData.value!)
// SEO-026: la valoración agregada sale solo de opiniones propias verificadas y se muestra tal cual en la ficha
const { data: reviewSeo } = await useFetch<ProductReviewSeoSummary>(
  () => `/api/products/${product.value.id}/reviews/summary`,
  { key: `review-seo-${route.params.slug}` }
)
const aggregateRating = computed(() => (reviewSeo.value ? buildAggregateRatingJsonLd(reviewSeo.value) : null))
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
onMounted(() => {
  void track('product_viewed', { productId: product.value.id, variantId: selected.value.id })
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
      ? { label: `Pocas unidades · ${selected.value.stock} disponibles`, tone: 'warning' }
      : { label: `${selected.value.stock} disponibles`, tone: 'available' }
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

// La estimación por producto existe en el entorno Node; en Cloudflare la entrega se calcula
// con el carrito, así que aquí no se enseña un formulario que no puede responder.
const deliveryEstimateAvailable = computed(() => runtime.public.serverRuntime !== 'cloudflare')
const deliveryMemory = useDeliveryDestination()
const deliveryEditing = ref(true)
const deliveryPostalCode = ref('')
const deliveryCity = ref('')
const deliveryLoading = ref(false)
const deliveryError = ref('')
interface DeliveryQuote {
  stockCondition: 'in_stock' | 'backorder'
  leadTimeDays: number | null
  rates: Array<{
    serviceCode: string
    label: string
    profile: string
    estimatedDeliveryFrom: string
    estimatedDeliveryTo: string
  }>
}
const deliveryQuote = ref<DeliveryQuote | null>(null)

function deliveryDate(value: string) {
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' }).format(new Date(value))
}

async function calculateDelivery() {
  deliveryError.value = ''
  deliveryQuote.value = null
  if (!/^\d{5}$/.test(deliveryPostalCode.value.trim()) || deliveryCity.value.trim().length < 2) {
    deliveryError.value = 'Indica código postal y población para calcular la entrega.'
    return
  }
  deliveryLoading.value = true
  try {
    const quote = await $fetch<DeliveryQuote>('/api/shipping/product-rates', {
      method: 'POST',
      body: {
        variantId: selected.value.uuid,
        quantity: qty.value,
        postalCode: deliveryPostalCode.value,
        city: deliveryCity.value
      }
    })
    deliveryQuote.value = quote
    if (!quote.rates.length) deliveryError.value = 'No hay un servicio contratado disponible para esa zona.'
    else if (deliveryMemory.remember({ postalCode: deliveryPostalCode.value, city: deliveryCity.value }))
      deliveryEditing.value = false
  } catch (error) {
    deliveryError.value = apiErrorMessage(error, 'No se puede confirmar una fecha de entrega para esa zona.')
  } finally {
    deliveryLoading.value = false
  }
}

watch([selectedId, qty], () => {
  deliveryQuote.value = null
  deliveryError.value = ''
  if (!deliveryEditing.value) void calculateDelivery()
})
onMounted(() => {
  if (!deliveryEstimateAvailable.value) return
  const known = deliveryMemory.restore()
  if (!known) return
  deliveryPostalCode.value = known.postalCode
  deliveryCity.value = known.city
  deliveryEditing.value = false
  void calculateDelivery()
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
// en productos por colores, una variante sin foto propia enseña la ilustración neutra:
// nunca la foto de otro color/producto. Y si la foto FALLA al cargar, también cae a la ilustración.
const mainImage = computed(() =>
  colorMode.value
    ? catalogImageSource(selected.value?.image, governedMedia)
    : (catalogImageSource(selected.value?.image, governedMedia) ??
      catalogImageSource(product.value.image, governedMedia))
)
// Mientras se comprueba la nueva foto se muestra el estado neutro, nunca el SKU anterior.
const shownImage = ref<string | null>(mainImage.value)
// esqueleto pulsante bajo la imagen grande mientras baja el derivado optimizado
const fichaImgLoaded = ref(false)
watch(shownImage, () => (fichaImgLoaded.value = false))
// URL optimizada (webp) que muestra la ficha. La precarga usa EXACTAMENTE esta URL:
// así al confirmar la carga el navegador ya la tiene en caché y el cambio es inmediato
// (antes se comprobaba la original y luego se descargaba el derivado: doble descarga)
const imgApi = useImage()
const fichaUrl = (src: string) =>
  publishedImageUrl(src, 1200, 'jpeg') ??
  (governedMedia ? '' : imgApi(src, { format: 'webp', quality: 80, width: 1120 }))
const imageAlt = computed(() =>
  selected.value.image && selected.value.image === shownImage.value
    ? selected.value.imageAlt || `${product.value.name} · ${selected.value.format}`
    : product.value.imageAlt || product.value.name
)
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
        image: shownImage.value ? [`${canonicalOrigin}${fichaUrl(shownImage.value)}`] : undefined,
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
watch(
  mainImage,
  (src) => {
    if (!src) {
      shownImage.value = null
      return
    }
    if (!import.meta.client) {
      shownImage.value = src
      return
    }
    // Selection has already changed: never present the previous SKU's image
    // beside the new SKU while its own approved derivative is being checked.
    shownImage.value = null
    const im = new Image()
    im.onload = () => {
      if (mainImage.value === src) shownImage.value = src
    }
    im.onerror = () => {
      if (mainImage.value === src) shownImage.value = null
    }
    im.src = fichaUrl(src)
  },
  { immediate: true }
)
// candidata LCP: precargar el derivado inicial desde el HTML
useHead({
  link: () => (shownImage.value ? [{ rel: 'preload', as: 'image', href: fichaUrl(shownImage.value) }] : [])
})
// pre-descarga en segundo plano (en ratos libres del navegador) de todos los colores
// de la rama activa: pasar de un color a otro queda instantáneo, ya están en caché
const prefetched = new Set<string>()
const colorImageUrls = computed(() =>
  colorOptions.value
    .map((parsed) => catalogImageSource(parsed.v.image, governedMedia))
    .filter((source): source is string => Boolean(source))
    .map((source) => fichaUrl(source))
)
watch(
  colorImageUrls,
  (opts, _previous, onCleanup) => {
    if (!import.meta.client) return
    const urls = opts.filter((url) => !prefetched.has(url))
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

// High-resolution selection stays behind the existing governed-media boundary
// and is evaluated only while the viewer is open.
const lightbox = ref(false)
const imageTrigger = ref<HTMLButtonElement | null>(null)
watch(
  [shownImage, selectedId],
  () => {
    lightbox.value = false
  },
  { flush: 'sync' }
)
const lightboxSrc = computed(() =>
  lightbox.value && shownImage.value
    ? (publishedImageUrl(shownImage.value, 1600, 'jpeg') ??
      (governedMedia ? null : imgApi(shownImage.value, { format: 'webp', quality: 85, width: 1800 })))
    : null
)

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

async function addToCart() {
  if (adding.value || !orderLines.value.length) return
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
    toast.add({
      title: 'Añadido al carrito',
      description:
        lines.length === 1
          ? `${product.value.name} · ${current.variant.format} × ${current.quantity}`
          : `${product.value.name} · ${lines.length} formatos, ${orderTotal.value.units} uds`,
      icon: 'i-lucide-shopping-cart',
      color: 'success'
    })
  } catch {
    toast.add({
      title: 'No se ha podido añadir',
      description: `${current.variant.format}: ${cart.error || 'actualiza la página y vuelve a intentarlo.'}`,
      icon: 'i-lucide-triangle-alert',
      color: 'error'
    })
  } finally {
    adding.value = false
  }
}

/** Productos con información regulatoria: necesitan su ficha de seguridad a mano. */
const regulated = computed(() => {
  const info = product.value.regulatory ?? {}
  return !!(info.signalWord || info.ufi || info.registrationNumber || info.hazardStatements?.length)
})
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-4 py-8 pb-24 lg:pb-8">
    <PromotionalBlocks
      :context="{
        placement: 'product',
        path: `/producto/${product.slug}`,
        productSlug: product.slug,
        categorySlug: product.breadcrumb.at(-1)?.slug
      }"
      class="mb-6"
    />
    <!-- migas -->
    <nav aria-label="Migas de pan" class="flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
      <NuxtLink to="/" class="hover:text-neteco-600">Inicio</NuxtLink>
      <template v-for="c in product.breadcrumb" :key="c.slug">
        <UIcon name="i-lucide-chevron-right" class="size-3.5" />
        <NuxtLink :to="`/categoria/${c.slug}`" class="hover:text-neteco-600">{{ c.name }}</NuxtLink>
      </template>
    </nav>

    <div class="mt-6 grid items-start gap-8 grid-cols-1 lg:grid-cols-2 xl:grid-cols-12">
      <!-- imagen -->
      <div
        class="relative self-start rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-10 xl:col-span-4"
      >
        <button
          v-if="shownImage"
          ref="imageTrigger"
          type="button"
          class="group relative block w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500 focus-visible:ring-offset-2"
          aria-label="Ver la imagen a pantalla completa"
          @click="lightbox = true"
        >
          <span
            v-if="!fichaImgLoaded"
            class="absolute inset-0 animate-pulse rounded-xl bg-slate-100"
            aria-hidden="true"
          />
          <PublishedProductImage
            v-if="publishedImageSources(shownImage)"
            :src="shownImage"
            :alt="imageAlt"
            sizes="(min-width: 1280px) 33vw, (min-width: 1024px) 50vw, 100vw"
            loading="eager"
            image-class="relative mx-auto aspect-square w-full rounded-xl bg-white object-contain"
            @load="fichaImgLoaded = true"
            @error="shownImage = null"
          />
          <img
            v-else
            :src="fichaUrl(shownImage)"
            :alt="imageAlt"
            width="800"
            height="800"
            class="relative mx-auto aspect-square w-full rounded-xl bg-white object-contain"
            @load="fichaImgLoaded = true"
            @error="shownImage = null"
          />
          <span
            class="absolute bottom-3 right-3 rounded-full bg-white/95 p-2.5 text-slate-600 opacity-0 shadow-md transition group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            <UIcon name="i-lucide-zoom-in" class="block size-5" />
          </span>
        </button>
        <!--
          Sin foto, la ilustración de familia dice el formato y el color, que ya es
          información. Lo que faltaba era la salida: en B2B, quien duda por no ver el
          producto llama y pregunta, así que se lo ofrecemos aquí en vez de dejarle
          con la duda.
        -->
        <div v-else class="flex aspect-square w-full flex-col items-center justify-center px-6">
          <ProductVisual :visual="product.visual" class="w-full max-w-[220px]" />
          <p class="mt-3 max-w-xs text-center text-sm text-[var(--text-muted)]">
            Todavía no tenemos foto de esta referencia.
            <NuxtLink
              :to="
                runtime.public.serverRuntime === 'cloudflare'
                  ? { path: '/contacto', query: { producto: product.slug } }
                  : '/contacto'
              "
              class="font-medium text-neteco-700 underline underline-offset-2"
            >
              Pídenosla
            </NuxtLink>
            y te la mandamos.
          </p>
        </div>
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
      <div class="xl:col-span-5">
        <p
          v-if="product.brand && !product.name.toUpperCase().startsWith(product.brand.toUpperCase())"
          class="text-[13px] font-medium text-[var(--text-muted)]"
        >
          {{ product.brand }}
        </p>
        <h1 class="mt-1 text-2xl font-bold text-slate-900 sm:text-3xl">{{ product.name }}</h1>
        <NuxtLink
          v-if="runtime.public.serverRuntime === 'cloudflare'"
          :to="{ path: '/contacto', query: { producto: product.slug } }"
          class="mt-2 inline-block text-sm font-medium text-neteco-700 underline underline-offset-2"
          >Consultar sobre este producto</NuxtLink
        >
        <p v-if="product.shortDesc" class="mt-3 text-slate-600">{{ product.shortDesc }}</p>

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
                :class="
                  selectedParsed?.axes[level - 1] === o
                    ? 'border-neteco-500 text-neteco-700 ring-1 ring-neteco-500'
                    : 'border-slate-200 text-slate-700 hover:border-neteco-300'
                "
                @click="pickAxis(level - 1, o)"
              >
                {{ axisDisplay(o) }}
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
                :style="{ backgroundColor: p.v.color ?? '#94a3b8' }"
                @click="selectedId = p.v.id"
              />
            </div>
            <p class="tabular mt-2.5 text-[13px] font-medium text-[var(--text-muted)]">Ref. {{ selected.sku }}</p>
          </div>
          <div class="flex items-center gap-3">
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
        </div>

        <!-- formatos -->
        <div v-else class="mt-6">
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
        <div v-if="product.siblings?.length" class="mt-6">
          <p class="mb-2 text-sm font-semibold text-slate-700">Otros colores y versiones de la gama</p>
          <div class="flex flex-wrap gap-2">
            <NuxtLink
              v-for="s in product.siblings"
              :key="s.slug"
              :to="`/producto/${s.slug}`"
              class="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-neteco-300 hover:text-neteco-700"
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

      <!-- Caja de compra fija, al estilo de las fichas de Amazon: precio, disponibilidad,
           cantidad y acción viven juntos y siguen visibles al bajar por la ficha. Antes
           estaban repartidos por la columna central y quedaban fuera de pantalla en cuanto
           se leía la descripción. -->
      <aside class="xl:col-span-3">
        <div
          class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 xl:sticky xl:top-24"
        >
          <div v-if="requestOnly" data-order-summary data-price-on-request>
            <p class="font-display text-[1.625rem] font-bold leading-tight text-[var(--text-strong)] sm:text-3xl">
              {{ PRICE_ON_REQUEST }}
            </p>
            <p class="tabular mt-1 text-[13px] font-medium text-[var(--text-muted)]">Ref. {{ selected.sku }}</p>
            <p v-if="sellingRule" class="mt-1 text-[13px] text-[var(--text-muted)]">{{ sellingRule }}</p>
          </div>
          <div v-else data-order-summary>
            <p class="text-[13px] font-medium text-[var(--text-muted)]">
              <template v-if="orderTotal.units">
                {{ orderTotal.units }} {{ orderTotal.units === 1 ? 'ud' : 'uds'
                }}<template v-if="orderLines.length > 1"> · {{ orderLines.length }} formatos</template>
              </template>
              <template v-else>Indica una cantidad</template>
            </p>
            <p
              data-order-total
              class="tabular font-display text-[1.625rem] font-bold leading-tight text-[var(--text-strong)] sm:text-3xl"
            >
              {{ formatPrice(showNetPrices ? orderTotal.net : orderTotal.gross) }}
              <span class="font-sans text-[13px] font-medium text-[var(--text-muted)]">
                {{ showNetPrices ? 'sin IVA' : 'IVA incluido' }}
              </span>
            </p>
            <p class="tabular text-[13px] text-[var(--text-muted)]">
              {{ formatPrice(showNetPrices ? orderTotal.gross : orderTotal.net) }}
              {{ showNetPrices ? 'con IVA' : 'sin IVA' }} ({{ selected.taxRateBasisPoints / 100 }} %)
              <template
                v-if="
                  orderLines.length <= 1 &&
                  perUnit(selected, showNetPrices ? selectedUnitNetPrice : selectedUnitGrossPrice)
                "
              >
                · {{ perUnit(selected, showNetPrices ? selectedUnitNetPrice : selectedUnitGrossPrice) }}
              </template>
            </p>
            <p
              v-if="orderLines.length <= 1"
              class="mt-2 flex items-center gap-1.5 text-[15px] font-medium"
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
            <p v-if="sellingRule" class="mt-1 text-[13px] text-[var(--text-muted)]">{{ sellingRule }}</p>
          </div>

          <VolumePricingTable
            v-if="!selectedOnRequest && selected.priceTiers.length"
            class="mt-4"
            :base-gross-cents="selected.price"
            :tax-rate-basis-points="2100"
            :tiers="selected.priceTiers"
            :current-quantity="qty"
            :show-net-prices="showNetPrices"
          />
          <p
            v-if="!selectedOnRequest && selected.compareAtPrice && selected.referencePrice30d"
            class="mt-3 text-xs text-slate-500"
          >
            Precio anterior: <s>{{ formatPrice(selected.compareAtPrice) }}</s> · Precio más bajo de los 30 días
            anteriores: {{ formatPrice(selected.referencePrice30d) }}.
          </p>

          <!-- Una sola acción principal. «Comprar ahora» se ha quitado: en reposición nadie compra
               una sola referencia. «Guardar en lista» lleva su texto, no un corazón suelto. -->
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
              @click="addToCart"
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

          <section
            v-if="deliveryEstimateAvailable"
            class="mt-5 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4"
            aria-labelledby="delivery-title"
          >
            <h2
              id="delivery-title"
              class="font-sans text-[15px] font-semibold tracking-normal text-[var(--text-strong)]"
            >
              ¿Cuándo me llega?
            </h2>
            <p v-if="!deliveryEditing" data-delivery-destination class="mt-1 text-[15px] text-[var(--text)]">
              Entrega en {{ deliveryPostalCode }} {{ deliveryCity }}
              <button
                type="button"
                data-delivery-change
                class="ml-1 font-semibold text-[var(--link)] underline"
                @click="deliveryEditing = true"
              >
                Cambiar
              </button>
            </p>
            <template v-else>
              <p class="mt-1 text-[13px] text-[var(--text-muted)]">
                Dinos dónde una vez y te damos la fecha estimada. La confirmamos al pagar.
              </p>
              <form class="mt-3 flex flex-col gap-2" @submit.prevent="calculateDelivery">
                <label class="sr-only" for="delivery-postal-code">Código postal</label>
                <UInput
                  id="delivery-postal-code"
                  v-model="deliveryPostalCode"
                  inputmode="numeric"
                  autocomplete="postal-code"
                  maxlength="5"
                  placeholder="Código postal"
                  class="w-full"
                />
                <label class="sr-only" for="delivery-city">Población</label>
                <UInput
                  id="delivery-city"
                  v-model="deliveryCity"
                  autocomplete="address-level2"
                  placeholder="Población"
                  class="w-full"
                />
                <UButton type="submit" variant="outline" block :loading="deliveryLoading">Ver fecha estimada</UButton>
              </form>
            </template>
            <p v-if="deliveryError" class="mt-2 text-sm text-amber-800" role="alert">{{ deliveryError }}</p>
            <ul v-else-if="deliveryQuote?.rates.length" class="mt-3 space-y-2" aria-live="polite">
              <li v-for="rate in deliveryQuote.rates" :key="rate.serviceCode" class="text-sm text-slate-700">
                <span class="font-semibold">{{ rate.label }}:</span>
                {{ deliveryDate(rate.estimatedDeliveryFrom) }}–{{ deliveryDate(rate.estimatedDeliveryTo) }}
                <span v-if="deliveryQuote.stockCondition === 'backorder'" class="text-amber-700">
                  · bajo pedido<template v-if="deliveryQuote.leadTimeDays">
                    (preparación estimada {{ deliveryQuote.leadTimeDays }} días)</template
                  >
                </span>
              </li>
            </ul>
          </section>

          <div class="mt-5 space-y-2 border-t border-[var(--border)] pt-4 text-sm text-[var(--text-muted)]">
            <p class="flex items-start gap-2">
              <UIcon name="i-lucide-truck" class="mt-0.5 size-4 shrink-0" /> {{ commercial.ownDelivery.value.text }}
            </p>
            <p v-if="commercial.parcel.value" class="flex items-start gap-2">
              <UIcon name="i-lucide-package-check" class="mt-0.5 size-4 shrink-0" /> {{ commercial.parcel.value.text }}
            </p>
            <p class="flex items-start gap-2">
              <UIcon name="i-lucide-phone" class="mt-0.5 size-4 shrink-0" />
              <span>Asesoramiento: <ContactAction link-class="underline" /></span>
            </p>
          </div>
        </div>
      </aside>

      <!-- Documentos y seguridad junto a la compra: en un químico profesional la ficha de datos
           de seguridad es requisito de compra, no letra pequeña al final de la página. -->
      <section
        v-if="technicalDocuments.length || regulated"
        data-product-documents
        class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4 xl:col-span-5 xl:col-start-5"
        aria-labelledby="documents-title"
      >
        <h2 id="documents-title" class="text-lg font-bold text-[var(--text-strong)]">Documentos</h2>
        <ul v-if="technicalDocuments.length" class="mt-3 flex flex-col gap-2">
          <li v-for="document in technicalDocuments" :key="`${document.id}-${document.role}-${document.version}`">
            <a
              :href="document.url"
              target="_blank"
              rel="noopener"
              class="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-[15px] font-medium text-[var(--text-strong)] hover:border-[var(--action)] hover:text-[var(--action)]"
            >
              <UIcon name="i-lucide-file-down" class="size-4 shrink-0 text-[var(--text-muted)]" />
              {{
                document.role === 'sds'
                  ? 'Ficha de datos de seguridad'
                  : document.role === 'datasheet'
                    ? 'Ficha técnica'
                    : document.role === 'label'
                      ? 'Etiqueta'
                      : 'Certificado'
              }}
              <span class="text-[13px] font-normal text-[var(--text-muted)]">
                PDF · v{{ document.version }}<template v-if="document.language"> · {{ document.language }}</template>
              </span>
            </a>
          </li>
        </ul>
        <p
          v-if="regulated && !technicalDocuments.some((document) => document.role === 'sds')"
          class="mt-3 text-[15px] text-[var(--text)]"
        >
          Pídenos la ficha de seguridad: <ContactAction />.
        </p>

        <div v-if="regulated" data-product-safety class="mt-4 border-t border-[var(--border)] pt-4 text-[15px]">
          <h3 class="font-semibold text-[var(--text-strong)]">Seguridad</h3>
          <p v-if="product.regulatory.signalWord" class="mt-1 flex items-center gap-1.5">
            <UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0 text-[var(--stock-low)]" />
            Palabra de advertencia: <strong>{{ product.regulatory.signalWord }}</strong>
          </p>
          <p v-if="product.regulatory.ufi" class="mt-1">
            UFI: <strong class="tabular">{{ product.regulatory.ufi }}</strong>
          </p>
          <p v-if="product.regulatory.registrationNumber" class="mt-1">
            Registro: <strong class="tabular">{{ product.regulatory.registrationNumber }}</strong>
          </p>
          <details
            v-if="product.regulatory.hazardStatements?.length || product.regulatory.precautionaryStatements?.length"
            class="mt-2"
            open
          >
            <summary class="cursor-pointer font-medium text-[var(--link)] underline">
              Indicaciones de peligro y consejos de prudencia
            </summary>
            <ul class="mt-2 list-disc pl-5 text-[var(--text)]">
              <li v-for="statement in product.regulatory.hazardStatements ?? []" :key="statement">
                {{ statement }}
              </li>
              <li v-for="statement in product.regulatory.precautionaryStatements ?? []" :key="statement">
                {{ statement }}
              </li>
            </ul>
          </details>
        </div>
      </section>
      <!-- SHP-029: peligros químicos/ADR de la variante elegida, siempre visibles -->
      <AdrHazardNotice
        v-if="engagementEnabled"
        :variant-id="String(selected.id)"
        class="xl:col-span-5 xl:col-start-5"
      />

      <section
        v-if="product.description || product.usage"
        class="border-t border-[var(--border)] pt-6 xl:col-span-5 xl:col-start-5"
      >
        <h2 class="text-lg font-bold text-[var(--text-strong)]">Descripción</h2>
        <p class="mt-3 whitespace-pre-line leading-relaxed text-[var(--text)]">{{ product.description }}</p>
        <template v-if="product.usage">
          <h3 class="mt-6 flex items-center gap-2 font-semibold text-[var(--text-strong)]">
            <UIcon name="i-lucide-beaker" class="size-4 text-[var(--text-muted)]" /> Modo de empleo y dosificación
          </h3>
          <p class="mt-2 leading-relaxed text-[var(--text)]">{{ product.usage }}</p>
        </template>
      </section>
    </div>

    <!-- ficha técnica -->
    <div class="mt-10">
      <div class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="text-lg font-bold text-slate-900">Características</h2>
        <dl
          class="mt-3 text-sm sm:columns-2 sm:gap-x-10 [&>div]:break-inside-avoid [&>div]:border-b [&>div]:border-slate-100"
        >
          <div v-if="product.brand" class="flex justify-between py-2">
            <dt class="text-slate-500">Marca</dt>
            <dd class="font-medium text-slate-700">{{ product.brand }}</dd>
          </div>
          <div class="flex justify-between py-2">
            <dt class="text-slate-500">Referencia</dt>
            <dd class="font-mono font-medium text-slate-700">{{ selected.sku }}</dd>
          </div>
          <div v-if="selected.ean || selected.gtin || selected.mpn" class="flex justify-between py-2">
            <dt class="text-slate-500">EAN / GTIN / MPN</dt>
            <dd class="font-mono text-right font-medium text-slate-700">
              {{ selected.ean || selected.gtin || selected.mpn }}
            </dd>
          </div>
          <template v-if="selectedSpecs">
            <div v-for="(s, index) in selectedSpecs" :key="`${s.k}-${index}`" class="flex justify-between gap-4 py-2">
              <dt class="shrink-0 text-slate-500">{{ s.k }}</dt>
              <dd class="flex items-center justify-end gap-1.5 text-right font-medium text-slate-700">
                <span
                  v-if="s.color"
                  class="size-3.5 shrink-0 rounded-full border border-black/15"
                  :style="{ backgroundColor: s.color }"
                />
                {{ s.v }}
              </dd>
            </div>
          </template>
          <div v-else class="flex justify-between py-2">
            <dt class="text-slate-500">Formato</dt>
            <dd class="font-medium text-slate-700">{{ selected.format }}</dd>
          </div>
          <div v-if="selected.units && selected.unitLabel === 'ud'" class="flex justify-between py-2">
            <dt class="text-slate-500">Unidades por envase</dt>
            <dd class="font-medium text-slate-700">{{ selected.units }}</dd>
          </div>
          <div v-if="sellingRule" class="flex justify-between py-2">
            <dt class="text-slate-500">Venta</dt>
            <dd class="font-medium text-slate-700">{{ sellingRule }}</dd>
          </div>
          <div v-if="selected.unitsPerCase > 1" class="flex justify-between py-2">
            <dt class="text-slate-500">Unidades por caja</dt>
            <dd class="font-medium text-slate-700">{{ selected.unitsPerCase }}</dd>
          </div>
          <div v-if="selected.casesPerPallet" class="flex justify-between py-2">
            <dt class="text-slate-500">Cajas por palé</dt>
            <dd class="font-medium text-slate-700">{{ selected.casesPerPallet }}</dd>
          </div>
          <div v-for="attribute in product.attrs" :key="attribute.k" class="flex justify-between gap-4 py-2">
            <dt class="shrink-0 text-slate-500">{{ attribute.k }}</dt>
            <dd class="text-right font-medium text-slate-700">{{ attribute.v }}</dd>
          </div>
          <div
            v-for="attribute in product.typedAttrs ?? []"
            :key="`${attribute.definitionId}:${attribute.revision}`"
            :data-typed-detail="attribute.definitionId"
            class="flex min-w-0 justify-between gap-4 py-2"
          >
            <dt class="min-w-0 break-words text-slate-500">{{ attribute.label }}</dt>
            <dd class="min-w-0 break-words text-right font-medium text-slate-700">{{ attribute.displayValue }}</dd>
          </div>
          <div class="flex justify-between py-2">
            <dt class="text-slate-500">Categoría</dt>
            <dd class="font-medium text-slate-700">{{ product.breadcrumb.at(-1)?.name }}</dd>
          </div>
        </dl>
        <UButton
          v-if="datasheet && runtime.public.appEnv !== 'production'"
          :href="datasheet"
          target="_blank"
          variant="soft"
          size="sm"
          icon="i-lucide-file-down"
          class="mt-4"
        >
          Descargar ficha técnica (PDF)
        </UButton>
      </div>
    </div>

    <!-- Guía de vídeo, dosificación y montaje (MED-016 y PDP-018) -->
    <ProductVideoMediaGuide :product-id="product.id" class="mt-8" />

    <ProductEngagementPanel
      v-if="engagementEnabled"
      :product-id="product.id"
      :variant-id="selected.id"
      :scope-key="engagementScope"
      :enabled="engagementEnabled"
      :customer-enabled="engagementCustomerEnabled"
      class="mt-8"
    />

    <!-- Reviews verificadas y Q&A moderado (PDP-016) -->
    <section v-if="reviewSeo" class="mt-8" aria-label="Valoración de clientes" data-testid="review-aggregate">
      <p v-if="aggregateRating" class="text-sm">
        <strong>{{ reviewSeo.averageRating.toFixed(1).replace('.', ',') }} / 5</strong>
        · {{ reviewSeo.eligibleCount }} opiniones de compradores verificados
      </p>
      <p class="text-xs text-gray-600">{{ reviewSeo.policy.text }}</p>
    </section>
    <ProductVerifiedReviewsQa :product-id="product.id" :product-name="product.name" class="mt-8" />

    <!-- Disponibilidad en el almacén único, alternativas revisadas y complementos (PDP-014/015/020) -->
    <ProductDetailExtras :product-slug="String(route.params.slug)" :variant-id="selected.id" class="mt-8" />

    <PublishedProductRelations :product-slugs="[String(route.params.slug)]" class="mt-8" />

    <!-- relacionados -->
    <section v-if="product.related?.length" class="mt-12">
      <h2 class="mb-4 text-xl font-bold text-slate-900">También te puede interesar</h2>
      <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
        <ProductCard v-for="p in product.related" :key="p.id" :product="p" />
      </div>
    </section>

    <ProductImageLightbox
      v-model:open="lightbox"
      :src="lightboxSrc"
      :alt="imageAlt"
      :name="product.name"
      :trigger="imageTrigger"
      :context-key="selectedId"
    />

    <!-- barra de compra fija (móvil): unidades, total y la misma acción que la caja de compra -->
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
        @click="addToCart"
      >
        <UIcon name="i-lucide-shopping-cart" class="size-5" />Añadir al carrito
      </button>
    </div>
  </div>
</template>
