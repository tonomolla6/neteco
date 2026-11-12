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
const resourceLabels: Record<Resource, string> = {
  orders: 'pedidos',
  profile: 'datos de cuenta',
  addresses: 'direcciones',
  favorites: 'listas'
}
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
const lastOrderItems = computed(() => lastOrderLines.value?.lines ?? [])
const recentOrders = computed(() => orders.value.slice(1, 4))
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

const shortcuts = computed(() => [
  {
    to: '/cuenta/pedidos',
    icon: 'i-lucide-package',
    label: 'Pedidos',
    hint: cloudflare
      ? readState.orders === 'success' && authorized()
        ? `${orders.value.length} consultados`
        : 'Pedidos no confirmados'
      : `${orders.value.length} en total`
  },
  {
    to: '/cuenta/listas',
    icon: 'i-lucide-list-checks',
    label: 'Listas',
    hint:
      cloudflare && (readState.favorites !== 'success' || !authorized())
        ? 'Listas no confirmadas'
        : favoriteCount.value
          ? `${favoriteCount.value} referencias`
          : 'Sin referencias guardadas'
  },
  {
    to: '/cuenta/direcciones',
    icon: 'i-lucide-map-pin',
    label: 'Direcciones',
    hint:
      cloudflare && (readState.addresses !== 'success' || !authorized())
        ? 'Direcciones no confirmadas'
        : defaultAddress.value
          ? cloudflare
            ? `${defaultAddress.value.city}${(addressData.value?.addresses.length ?? 0) > 1 ? ` y ${addressData.value!.addresses.length - 1} más` : ''}`
            : `${defaultAddress.value.city} y ${addressData?.value?.addresses.length ?? 0} más`
          : 'Sin direcciones'
  },
  {
    to: '/cuenta/seguridad',
    icon: 'i-lucide-shield-check',
    label: 'Acceso y seguridad',
    hint: 'Contraseña, MFA y sesiones'
  }
])

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
  <div class="space-y-6">
    <UiPageHeader title="Resumen" description="Tu último pedido, tus datos y los accesos rápidos a cada sección." />

    <AccountFeedback :notice="notice" />
    <B2BCustomerTerms v-if="cloudflare" :enabled="authorized()" :scope-key="scopeKey" />
    <div v-if="cloudflare" class="space-y-3">
      <p v-if="!authorized()" role="status">
        Confirma tu sesión y correo verificado para consultar el resumen privado.
      </p>
      <UButton :disabled="!authorized() || Object.values(readState).includes('pending')" @click="readAll"
        >Actualizar resumen</UButton
      >
      <template v-for="(label, name) in resourceLabels" :key="name">
        <section v-if="readState[name] !== 'success'" class="rounded-lg border p-3 text-sm">
          <p v-if="readState[name] === 'pending'" :data-overview-loading="name" role="status">
            Consultando {{ label }}…
          </p>
          <p v-else-if="readState[name] === 'error'" :data-overview-error="name" role="alert">
            No se han podido confirmar {{ label }}. No se interpreta como datos vacíos.
          </p>
          <p v-else role="status">{{ label }} sin confirmar.</p>
          <UButton
            :data-overview-retry="name"
            :disabled="!authorized() || readState[name] === 'pending'"
            @click="readResource(name)"
            >Volver a consultar {{ label }}</UButton
          >
        </section>
      </template>
    </div>

    <!-- Lo primero de la página es la acción principal, no un formulario de perfil -->
    <UiSurface v-if="lastOrder" tone="accent" padding="lg">
      <div class="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div class="min-w-0">
          <p class="text-[13px] font-semibold text-[var(--text-muted)]">Tu último pedido</p>
          <p class="tabular mt-1 text-2xl font-bold text-[var(--text-strong)]">{{ lastOrder.id }}</p>
          <p class="mt-1 text-[var(--text-muted)]">
            {{ formatAccountDate(lastOrder.createdAt) }} · {{ lastOrder.lines }}
            {{ lastOrder.lines === 1 ? 'referencia' : 'referencias' }} ·
            <span class="tabular font-semibold text-[var(--text-strong)]">{{ formatPrice(lastOrder.total) }}</span>
          </p>
          <UBadge
            class="mt-3"
            variant="subtle"
            :color="(ORDER_STATUS[lastOrder.status] ?? ORDER_STATUS.pendiente_pago!).color"
            :icon="(ORDER_STATUS[lastOrder.status] ?? ORDER_STATUS.pendiente_pago!).icon"
          >
            {{ (ORDER_STATUS[lastOrder.status] ?? ORDER_STATUS.pendiente_pago!).label }}
          </UBadge>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton
            size="lg"
            icon="i-lucide-rotate-cw"
            :disabled="cloudflare && readState.lines !== 'success'"
            @click="startReorder(lastOrder.id)"
          >
            Volver a pedir
          </UButton>
          <UButton size="lg" color="neutral" variant="outline" to="/cuenta/pedidos">Ver mis pedidos</UButton>
        </div>
      </div>
      <div v-if="cloudflare && readState.lines !== 'success'" class="mt-4 rounded-lg border p-3 text-sm">
        <p v-if="readState.lines === 'pending'" data-overview-loading="lines" role="status">
          Consultando las referencias del último pedido…
        </p>
        <p v-else data-overview-error="lines" role="alert">
          No se han podido confirmar las referencias. La recompra permanece deshabilitada.
        </p>
        <UButton
          data-overview-retry="lines"
          :disabled="!authorized() || readState.lines === 'pending'"
          @click="readLines"
          >Consultar referencias</UButton
        >
      </div>

      <!-- Qué llevaba: «volver a pedir» sin enseñar el qué obliga a salir de la página -->
      <ul v-if="lastOrderItems.length" class="mt-5 space-y-2 border-t border-neteco-200 pt-4">
        <li v-for="line in lastOrderItems.slice(0, 4)" :key="line.sku" class="flex items-center gap-3">
          <OrderLineThumb :line="line" size="sm" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-[var(--text-strong)]">{{ line.name }}</p>
            <p class="truncate text-xs text-[var(--text-muted)]">{{ line.format }} · Ref. {{ line.sku }}</p>
          </div>
          <span class="tabular shrink-0 text-sm text-[var(--text-muted)]">× {{ line.quantity }}</span>
        </li>
        <li v-if="lastOrderItems.length > 4" class="pl-13 text-sm text-[var(--text-muted)]">
          y {{ lastOrderItems.length - 4 }}
          {{ lastOrderItems.length - 4 === 1 ? 'referencia más' : 'referencias más' }}
        </li>
      </ul>
    </UiSurface>

    <UiSurface v-else-if="!cloudflare || (authorized() && readState.orders === 'success')" padding="none">
      <UiEmptyState
        icon="i-lucide-package"
        title="Aún no has hecho ningún pedido"
        description="Cuando hagas el primero, podrás repetirlo desde aquí en un par de clics."
      >
        <UButton to="/catalogo" icon="i-lucide-arrow-right" trailing>Ver el catálogo</UButton>
      </UiEmptyState>
    </UiSurface>

    <!-- Estado de la cuenta profesional: antes se leía «Estado: pending · company_admin» -->
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

    <div class="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
      <NuxtLink
        v-for="shortcut in shortcuts"
        :key="shortcut.to"
        :to="shortcut.to"
        class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:border-neteco-300"
      >
        <UIcon :name="shortcut.icon" class="size-5 text-neteco-700" />
        <p class="mt-2.5 font-semibold text-[var(--text-strong)]">{{ shortcut.label }}</p>
        <p class="mt-0.5 text-sm text-[var(--text-muted)]">{{ shortcut.hint }}</p>
      </NuxtLink>
    </div>

    <section v-if="recentOrders.length">
      <div class="flex items-center justify-between pb-3">
        <h2 class="text-lg font-bold text-[var(--text-strong)]">Pedidos anteriores</h2>
        <UButton size="sm" color="neutral" variant="ghost" to="/cuenta/pedidos" trailing icon="i-lucide-chevron-right">
          Ver todos
        </UButton>
      </div>
      <div class="space-y-3">
        <AccountOrderRow v-for="order in recentOrders" :key="order.id" :order="order" @reorder="startReorder" />
      </div>
    </section>

    <p v-if="openOrders" class="text-sm text-[var(--text-muted)]">
      <template v-if="cloudflare"
        >Entre los pedidos consultados hay {{ openOrders }}
        {{ openOrders === 1 ? 'pedido en curso' : 'pedidos en curso' }}.</template
      >
      <template v-else
        >Tienes {{ openOrders }} {{ openOrders === 1 ? 'pedido en curso' : 'pedidos en curso' }}.</template
      >
      <NuxtLink to="/cuenta/pedidos" class="font-medium text-neteco-700 underline">Seguir su estado</NuxtLink>
    </p>

    <p v-if="cloudflare && orders.length === 200" role="status" class="text-sm text-[var(--text-muted)]">
      Esta consulta muestra como máximo los 200 más recientes; no confirma el total histórico de la cuenta.
    </p>
    <ReorderDialog
      v-if="!cloudflare || (authorized() && readState.orders === 'success')"
      :key="cloudflare ? scopeKey : 'node'"
      ref="dialog"
      @added="onAdded"
    />
  </div>
</template>
