<script setup lang="ts">
import type { AccountProfile, Address, FavoriteList, OrderDetailLines, OrderSummary } from '~/composables/useAccount'
import { z } from 'zod'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { readOrderDetail } from '~/utils/orderDetail'

definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Mi cuenta', robots: 'noindex, nofollow' })

/**
 * Resumen del área de cliente.
 *
 * La pantalla anterior ponía «Mis pedidos» en la posición once, por debajo de la
 * configuración de privacidad. Aquí el último pedido va primero y con su acción
 * principal a la vista, porque es lo que viene a hacer el cliente de un proveedor
 * de reposición. Todo lo demás son accesos, no formularios.
 */
const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
const { ready, loggedIn, user, session } = useUserSession()
const requestFetch = useRequestFetch()
const orderData = cloudflare
  ? shallowRef<{ orders: OrderSummary[] } | null>(null)
  : (await useFetch<{ orders: OrderSummary[] }>('/api/orders')).data
const accountData = cloudflare
  ? shallowRef<{ profile: AccountProfile } | null>(null)
  : (await useFetch<{ profile: AccountProfile }>('/api/account')).data
const addressData = cloudflare
  ? shallowRef<{ addresses: Address[] } | null>(null)
  : (await useFetch<{ addresses: Address[] }>('/api/account/addresses')).data
const favoriteData = cloudflare
  ? shallowRef<{ lists: FavoriteList[] } | null>(null)
  : (await useFetch<{ lists: FavoriteList[] }>('/api/account/favorites')).data
const scopeKey = computed(() =>
  JSON.stringify([
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
type Resource = 'orders' | 'profile' | 'addresses' | 'favorites'
type ReadState = 'idle' | 'pending' | 'success' | 'error'
const readState = reactive<Record<Resource | 'lines', ReadState>>({
  orders: 'idle',
  profile: 'idle',
  addresses: 'idle',
  favorites: 'idle',
  lines: 'idle'
})
const text = z.string().max(4096),
  nullableText = text.nullable()
const ordersSchema = z
  .object({
    orders: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            status: z.string().refine((value) => Object.hasOwn(ORDER_STATUS, value)),
            total: z.number().int().safe().nonnegative(),
            createdAt: z.string().datetime(),
            lines: z.number().int().safe().nonnegative(),
            invoiceAvailable: z.boolean(),
            fullDetailAvailable: z.boolean()
          })
          .strict()
      )
      .max(200)
  })
  .strict()
  .refine(({ orders }) => new Set(orders.map((order) => order.id)).size === orders.length)
const profileSchema = z
  .object({
    profile: z
      .object({
        name: nullableText,
        phone: nullableText,
        email: text.min(1),
        companyId: z.string().uuid().nullable().optional(),
        company: nullableText,
        tradeName: nullableText,
        taxId: nullableText,
        countryCode: nullableText,
        companyStatus: nullableText,
        companyRole: nullableText
      })
      .strict()
  })
  .strict()
const addressesSchema = z
  .object({
    addresses: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            kind: z.enum(['shipping', 'billing', 'both']),
            label: text,
            recipientName: text,
            companyName: nullableText,
            taxId: nullableText,
            line1: text,
            line2: nullableText,
            postalCode: text,
            city: text,
            region: text,
            countryCode: z.string().regex(/^[A-Z]{2}$/),
            phone: nullableText,
            instructions: nullableText,
            isDefault: z.boolean(),
            createdAt: z.string().datetime(),
            updatedAt: z.string().datetime()
          })
          .strict()
      )
      .max(50)
  })
  .strict()
  .refine(({ addresses }) => new Set(addresses.map((address) => address.id)).size === addresses.length)
const positive = z.number().int().safe().positive()
const favoriteItemSchema = z
  .object({
    variantId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
      .max(128),
    cartVariantId: positive.nullable(),
    sku: text.min(1),
    quantity: z.string().regex(/^[1-9][0-9]{0,2}$/),
    name: text.min(1),
    slug: text.min(1),
    format: text.min(1),
    unitLabel: text.min(1),
    minimumQuantity: positive,
    maximumQuantity: positive.nullable(),
    quantityIncrement: positive,
    available: z.boolean(),
    reason: z.enum(['unpublished', 'quantity_changed', 'out_of_stock', 'cart_unmapped']).nullable()
  })
  .strict()
  .refine((item) => item.available === (item.reason === null) && (!item.available || item.cartVariantId !== null))
const favoritesSchema = z
  .object({
    lists: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
              .max(128),
            name: z.string().min(1).max(80),
            isDefault: z.boolean(),
            items: z.array(favoriteItemSchema).max(100)
          })
          .strict()
          .refine((list) => new Set(list.items.map((item) => item.variantId)).size === list.items.length)
      )
      .max(21)
  })
  .strict()
  .refine(
    ({ lists }) =>
      new Set(lists.map((list) => list.id)).size === lists.length &&
      lists.filter((list) => list.isDefault).length <= 1 &&
      lists.filter((list) => !list.isDefault).length <= 20
  )
const readers = {
  orders: {
    path: '/api/orders',
    accept: (raw: unknown) => {
      orderData.value = ordersSchema.parse(raw)
    }
  },
  profile: {
    path: '/api/account',
    accept: (raw: unknown) => {
      accountData.value = profileSchema.parse(raw)
    }
  },
  addresses: {
    path: '/api/account/addresses',
    accept: (raw: unknown) => {
      addressData.value = addressesSchema.parse(raw)
    }
  },
  favorites: {
    path: '/api/account/favorites',
    accept: (raw: unknown) => {
      favoriteData.value = favoritesSchema.parse(raw)
    }
  }
}
const sources = { orders: orderData, profile: accountData, addresses: addressData, favorites: favoriteData }
let active = true,
  mounted = false,
  started = false,
  generation = 0
const flights = new Set<Resource | 'lines'>()
function authorized() {
  return (
    active &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    z.string().uuid().safeParse(user.value?.id).success &&
    z.string().uuid().safeParse(session.value?.sessionId).success &&
    typeof session.value?.sessionVersion === 'number' &&
    Number.isSafeInteger(session.value.sessionVersion) &&
    session.value.sessionVersion >= 1
  )
}
function purge() {
  generation++
  for (const name of Object.keys(readers) as Resource[]) {
    sources[name].value = null
    readState[name] = 'idle'
  }
  lastOrderLines.value = null
  readState.lines = 'idle'
  flights.clear()
  notice.value = ''
}
async function readResource(name: Resource) {
  if (!cloudflare || !authorized() || flights.has(name)) return
  const epoch = generation,
    scope = scopeKey.value
  const current = () => active && generation === epoch && scopeKey.value === scope && authorized()
  flights.add(name)
  readState[name] = 'pending'
  sources[name].value = null
  if (name === 'orders') {
    lastOrderLines.value = null
    readState.lines = 'idle'
  }
  try {
    const raw: unknown = await requestFetch(readers[name].path, { method: 'GET', retry: 0, cache: 'no-store' })
    if (!current()) return
    readers[name].accept(catalogPolicyOwnJson(raw))
    readState[name] = 'success'
    if (name === 'orders' && lastOrder.value) await readLines()
  } catch {
    if (current()) {
      sources[name].value = null
      readState[name] = 'error'
    }
  } finally {
    if (current()) flights.delete(name)
  }
}
async function readLines() {
  const id = lastOrder.value?.id
  if (!cloudflare || !authorized() || !id || readState.orders !== 'success' || flights.has('lines')) return
  const epoch = generation,
    scope = scopeKey.value
  const current = () =>
    active && generation === epoch && scopeKey.value === scope && authorized() && lastOrder.value?.id === id
  flights.add('lines')
  readState.lines = 'pending'
  lastOrderLines.value = null
  try {
    const raw: unknown = await requestFetch(`/api/orders/${id}/lines`, { method: 'GET', retry: 0, cache: 'no-store' })
    if (!current()) return
    const parsed = readOrderDetail(raw, id)
    if (!parsed || parsed.lines.some((line) => line.reorderOffer === undefined))
      throw new Error('unconfirmed_order_lines')
    lastOrderLines.value = parsed
    readState.lines = 'success'
  } catch {
    if (current()) {
      lastOrderLines.value = null
      readState.lines = 'error'
    }
  } finally {
    if (current()) flights.delete('lines')
  }
}
function readAll() {
  if (!authorized() || Object.values(readState).includes('pending')) return
  started = true
  void Promise.all((Object.keys(readers) as Resource[]).map(readResource))
}

const dialog = useTemplateRef('dialog')
const notice = ref('')

const orders = computed(() =>
  !cloudflare || (authorized() && readState.orders === 'success') ? (orderData.value?.orders ?? []) : []
)
const lastOrder = computed(() => orders.value[0])

// Qué llevaba el último pedido: sin esto la tarjeta dice «vuelve a pedir» sin enseñar qué.
const lastOrderLines = cloudflare
  ? shallowRef<OrderDetailLines | null>(null)
  : (
      await useLazyFetch<OrderDetailLines>(() => `/api/orders/${lastOrder.value?.id}/lines`, {
        immediate: Boolean(orders.value.length),
        key: 'last-order-lines'
      })
    ).data
const previousOrders = computed(() => orders.value.slice(0, 3))
const sectionGroups = computed(() => accountSectionGroups(cloudflare))
const greetingName = computed(() => user.value?.name || user.value?.company || user.value?.email || 'cliente')
const openOrders = computed(
  () => orders.value.filter((order) => !['entregado', 'cancelado', 'reembolsado'].includes(order.status)).length
)
const favoriteCount = computed(
  () => favoriteData.value?.lists.reduce((total, list) => total + list.items.length, 0) ?? 0
)
const defaultAddress = computed(
  () => addressData.value?.addresses.find((address) => address.isDefault) ?? addressData.value?.addresses[0]
)
const companyStatus = computed(() => {
  const raw = accountData.value?.profile.companyStatus
  return raw ? (COMPANY_STATUS[raw] ?? { label: raw, color: 'neutral' as const }) : null
})

const commercial = useCommercialTerms()
const companyExplanation = computed(() =>
  companyStatusExplanation(accountData.value?.profile.companyStatus, {
    bankTransfer: useRuntimeConfig().public.bankTransferEnabled === true,
    deferredDays: commercial.terms.value.deferredPaymentDays,
    contact: commercial.contact.value
  })
)

const listsConfirmed = computed(() => !cloudflare || (readState.favorites === 'success' && authorized()))
const listsHint = computed(() =>
  !listsConfirmed.value
    ? 'Listas no confirmadas'
    : favoriteCount.value
      ? `${favoriteCount.value} referencias`
      : 'Sin referencias guardadas'
)
const deliveryHint = computed(() =>
  cloudflare && (readState.addresses !== 'success' || !authorized())
    ? 'Direcciones no confirmadas'
    : defaultAddress.value
      ? cloudflare
        ? `${defaultAddress.value.city}${(addressData.value?.addresses.length ?? 0) > 1 ? ` y ${addressData.value!.addresses.length - 1} más` : ''}`
        : `${defaultAddress.value.city} y ${addressData?.value?.addresses.length ?? 0} más`
      : 'Sin direcciones'
)

/**
 * Los bloques de la portada enseñan el dato real cuando ya está leído (cuántos pedidos hay en
 * curso, dónde se entrega) y, mientras tanto, la descripción fija de la sección.
 */
const blockHints = computed<Record<string, string>>(() => {
  const hints: Record<string, string> = {}
  const ordersRead = !cloudflare || (readState.orders === 'success' && authorized())
  if (ordersRead && orders.value.length)
    hints['/cuenta/pedidos'] = openOrders.value
      ? `${openOrders.value} ${openOrders.value === 1 ? 'pedido en curso' : 'pedidos en curso'}. Sigue el envío o repite una compra.`
      : 'Repite una compra, descarga la factura o consulta un pedido anterior.'
  if (listsConfirmed.value && favoriteCount.value)
    hints['/cuenta/listas'] = `${listsHint.value} guardadas para volver a pedir.`
  const addressesRead = !cloudflare || (readState.addresses === 'success' && authorized())
  if (addressesRead && defaultAddress.value) hints['/cuenta/direcciones'] = `Entrega habitual en ${deliveryHint.value}.`
  return hints
})

function onAdded(count: number) {
  if (cloudflare && (!authorized() || readState.orders !== 'success' || !Number.isSafeInteger(count) || count < 1))
    return
  notice.value = `${count} ${count === 1 ? 'referencia añadida' : 'referencias añadidas'} al carrito.`
}
function startReorder(id: string) {
  if (
    cloudflare &&
    (!authorized() ||
      readState.orders !== 'success' ||
      !orders.value.some((order) => order.id === id) ||
      (id === lastOrder.value?.id && readState.lines !== 'success'))
  )
    return
  dialog.value?.start(id)
}
if (cloudflare) {
  watch(scopeKey, purge, { flush: 'sync' })
  watch(
    () => authorized(),
    (value) => {
      if (mounted && value && !started) readAll()
    },
    { flush: 'sync' }
  )
  watch(
    ready,
    (value) => {
      if (!value) purge()
    },
    { flush: 'sync' }
  )
}
onMounted(() => {
  mounted = true
  if (cloudflare) readAll()
})
onBeforeUnmount(() => {
  active = false
  if (cloudflare) purge()
})
</script>

<template>
  <div class="space-y-8">
    <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div class="min-w-0">
        <h1>Mi cuenta</h1>
        <p class="mt-1.5 text-[var(--text-muted)]">
          Hola, <span class="font-semibold text-[var(--text-strong)]">{{ greetingName }}</span
          >. Desde aquí gestionas tus pedidos, tus datos y tus avisos.
        </p>
      </div>
      <UButton to="/catalogo" color="neutral" variant="outline" icon="i-lucide-shopping-bag">Seguir comprando</UButton>
    </div>

    <AccountFeedback :notice="notice" />
    <B2BCustomerTerms v-if="cloudflare" :enabled="authorized()" :scope-key="scopeKey" />

    <!-- Estado de la cuenta profesional -->
    <UiSurface v-if="companyStatus" padding="sm">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <UIcon name="i-lucide-building-2" class="size-4 text-[var(--text-muted)]" />
          <span class="font-medium text-[var(--text-strong)]">
            {{ accountData?.profile.company || 'Cuenta profesional' }}
          </span>
          <UBadge :color="companyStatus.color" variant="subtle">{{ companyStatus.label }}</UBadge>
          <span v-if="accountData?.profile.companyRole" class="text-[var(--text-muted)]">
            {{ COMPANY_ROLE[accountData.profile.companyRole] ?? accountData.profile.companyRole }}
          </span>
        </div>
        <UButton size="sm" color="neutral" variant="ghost" to="/cuenta/datos" trailing icon="i-lucide-chevron-right">
          Gestionar
        </UButton>
      </div>
      <p v-if="companyExplanation" data-company-explanation class="mt-2 text-sm text-[var(--text)]">
        {{ companyExplanation }}
      </p>
    </UiSurface>

    <!-- Bloques clicables: cada sección de la cuenta, a un clic -->
    <section v-for="group in sectionGroups" :key="group.title" :aria-label="group.title" data-account-blocks>
      <h2 class="pb-3">{{ group.title }}</h2>
      <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <li v-for="section in group.sections" :key="section.to + section.label">
          <NuxtLink
            :to="section.to"
            class="account-block group flex h-full items-start gap-4 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-neteco-300 hover:bg-neteco-50/40 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)] sm:p-5"
          >
            <span
              class="grid size-12 shrink-0 place-items-center rounded-full bg-neteco-50 text-neteco-700 group-hover:bg-neteco-100"
            >
              <UIcon :name="section.icon" class="size-6" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-base font-bold text-[var(--text-strong)]">{{ section.label }}</span>
              <span class="mt-0.5 block text-sm leading-snug text-[var(--text-muted)]">
                {{ blockHints[section.to] ?? section.description }}
              </span>
            </span>
            <UIcon
              name="i-lucide-chevron-right"
              class="mt-1 size-4 shrink-0 text-[var(--text-muted)] group-hover:text-neteco-700"
            />
          </NuxtLink>
        </li>
      </ul>
    </section>

    <!-- Pedidos anteriores: al final, como referencia; la gestión completa vive en Pedidos -->
    <section aria-labelledby="account-previous-orders" data-account-previous-orders>
      <div class="flex flex-wrap items-center justify-between gap-3 pb-3">
        <h2 id="account-previous-orders">Pedidos anteriores</h2>
        <UButton
          v-if="orders.length"
          size="sm"
          color="neutral"
          variant="ghost"
          to="/cuenta/pedidos"
          trailing
          icon="i-lucide-chevron-right"
        >
          Ver todos los pedidos
        </UButton>
      </div>

      <div v-if="cloudflare && readState.orders === 'pending'" role="status" class="space-y-3">
        <p class="sr-only" data-overview-loading="orders">Consultando pedidos…</p>
        <div
          v-for="row in 2"
          :key="row"
          class="h-40 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-sunken)]"
          aria-hidden="true"
        />
      </div>
      <UiSurface v-else-if="cloudflare && readState.orders === 'error'" padding="sm">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p data-overview-error="orders" class="text-sm text-[var(--text)]">
            No hemos podido cargar tus pedidos ahora mismo.
          </p>
          <UButton
            data-overview-retry="orders"
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-rotate-cw"
            :disabled="!authorized()"
            @click="readResource('orders')"
          >
            Reintentar
          </UButton>
        </div>
      </UiSurface>
      <div v-else-if="previousOrders.length" class="space-y-4">
        <AccountOrderRow v-for="order in previousOrders" :key="order.id" :order="order" @reorder="startReorder" />
      </div>
      <UiSurface v-else-if="!cloudflare || (authorized() && readState.orders === 'success')" padding="none">
        <UiEmptyState
          icon="i-lucide-package"
          title="Aún no has hecho ningún pedido"
          description="Cuando hagas el primero, podrás seguirlo y repetirlo desde aquí."
        >
          <UButton to="/catalogo" icon="i-lucide-arrow-right" trailing>Ver el catálogo</UButton>
        </UiEmptyState>
      </UiSurface>

      <p v-if="cloudflare && orders.length === 200" role="status" class="mt-3 text-sm text-[var(--text-muted)]">
        Se muestran como máximo los 200 pedidos más recientes.
      </p>
    </section>

    <ReorderDialog
      v-if="!cloudflare || (authorized() && readState.orders === 'success')"
      :key="cloudflare ? scopeKey : 'node'"
      ref="dialog"
      @added="onAdded"
    />
  </div>
</template>
