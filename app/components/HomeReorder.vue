<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import type { HabitualProduct } from '~~/shared/habitual-products'

/**
 * Portada de quien ya es cliente.
 *
 * En un negocio de reposición la acción principal de quien vuelve es repetir, no descubrir.
 * Con sesión y al menos un pedido, lo primero que se ve es el último pedido con su botón,
 * los accesos a pedido rápido y listas, y las referencias habituales con la cantidad de
 * siempre. Sin sesión o sin pedidos este bloque no existe.
 */
const { user } = useUserSession()
const { orders, lastOrder } = await useLastOrder()
const { habituals } = useHabituals(orders)
const { ownDelivery } = useCommercialTerms()
const cart = useCartStore()
const dialog = useTemplateRef<{ start: (orderId: string) => void }>('dialog')
const LISTS_PATH = '/cuenta/favoritos'

const greeting = computed(() => user.value?.company || user.value?.name?.split(' ')[0] || '')

const quantities = reactive<Record<number, number>>({})
watch(
  habituals,
  (list) => {
    for (const item of list) quantities[item.variantId] ??= item.usualQuantity
  },
  { immediate: true }
)
const state = reactive<Record<number, 'adding' | 'added' | undefined>>({})
const errors = reactive<Record<number, string>>({})
const announcement = ref('')
const timers = new Map<number, ReturnType<typeof setTimeout>>()
onBeforeUnmount(() => timers.forEach((timer) => clearTimeout(timer)))

async function add(item: HabitualProduct) {
  if (state[item.variantId] === 'adding' || cart.blockedMutations) return
  const quantity = quantities[item.variantId] ?? item.usualQuantity
  state[item.variantId] = 'adding'
  errors[item.variantId] = ''
  try {
    await cart.add(
      {
        variantId: item.variantId,
        sku: item.sku,
        name: item.name,
        format: item.format,
        ...(item.slug ? { slug: item.slug } : {}),
        ...(item.visual ? { visual: item.visual } : {}),
        image: item.image
      },
      quantity
    )
    state[item.variantId] = 'added'
    announcement.value = `${quantity} × ${item.name} en el carrito`
    clearTimeout(timers.get(item.variantId))
    timers.set(
      item.variantId,
      setTimeout(() => (state[item.variantId] = undefined), 2000)
    )
  } catch {
    state[item.variantId] = undefined
    errors[item.variantId] = cart.error || 'No se ha podido añadir. Vuelve a intentarlo.'
  }
}
</script>

<template>
  <section v-if="lastOrder" data-home-reorder class="border-b border-[var(--border)] bg-[var(--surface)]">
    <div class="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8">
      <h1 class="text-2xl font-bold text-[var(--text-strong)] sm:text-3xl">
        Hola<template v-if="greeting">, {{ greeting }}</template>
      </h1>

      <div class="mt-4 grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div>
          <div
            data-last-order
            class="rounded-[var(--radius-panel)] border border-[var(--border-strong)] bg-[var(--surface)] p-4 sm:p-5"
          >
            <p class="text-[13px] font-medium text-[var(--text-muted)]">
              Tu último pedido · {{ formatAccountDate(lastOrder.createdAt) }}
            </p>
            <p class="tabular mt-1 text-lg font-bold text-[var(--text-strong)]">
              {{ lastOrder.lines }} {{ lastOrder.lines === 1 ? 'referencia' : 'referencias' }} ·
              {{ formatPrice(lastOrder.total) }}
            </p>
            <button
              type="button"
              data-repeat-order
              class="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--action)] px-5 font-semibold text-white transition-colors hover:bg-[var(--action-hover)]"
              @click="dialog?.start(lastOrder.id)"
            >
              <UIcon name="i-lucide-rotate-cw" class="size-4" /> Repetir este pedido
            </button>
            <NuxtLink
              to="/cuenta/pedidos"
              class="mt-3 block text-center text-[15px] font-medium text-[var(--link)] underline"
            >
              Ver mis pedidos
            </NuxtLink>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-3">
            <NuxtLink
              to="/pedido-rapido"
              class="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[15px] font-semibold text-[var(--text-strong)] hover:border-[var(--action)]"
            >
              <UIcon name="i-lucide-list-plus" class="size-4 text-[var(--text-muted)]" /> Pedido rápido
            </NuxtLink>
            <NuxtLink
              :to="LISTS_PATH"
              class="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[15px] font-semibold text-[var(--text-strong)] hover:border-[var(--action)]"
            >
              <UIcon name="i-lucide-list-checks" class="size-4 text-[var(--text-muted)]" /> Mis listas
            </NuxtLink>
          </div>
          <p
            v-if="ownDelivery.concrete"
            data-next-delivery
            class="mt-3 flex items-start gap-2 text-[13px] text-[var(--text-muted)]"
          >
            <UIcon name="i-lucide-truck" class="mt-0.5 size-4 shrink-0" />{{ ownDelivery.text }}
          </p>
        </div>

        <div v-if="habituals.length" class="min-w-0">
          <div class="flex items-baseline justify-between gap-3">
            <h2 class="text-lg font-bold text-[var(--text-strong)] sm:text-[1.375rem]">Tus habituales</h2>
            <NuxtLink to="/cuenta/pedidos" class="text-[15px] font-medium text-[var(--link)] underline">
              Ver pedidos
            </NuxtLink>
          </div>
          <ul class="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius-panel)] border border-[var(--border)]">
            <li
              v-for="item in habituals"
              :key="item.variantId"
              data-habitual
              class="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3 sm:grid-cols-[3rem_minmax(0,1fr)_auto]"
            >
              <ProductImage :product="item" sizes="48px" />
              <div class="min-w-0">
                <component
                  :is="item.slug ? resolveComponent('NuxtLink') : 'span'"
                  :to="item.slug ? `/producto/${item.slug}` : undefined"
                  class="line-clamp-2 text-[15px] font-semibold leading-snug text-[var(--text-strong)]"
                  :class="item.slug ? 'hover:underline' : ''"
                >
                  {{ item.name }}
                </component>
                <p class="tabular text-[13px] text-[var(--text-muted)]">
                  Ref. {{ item.sku }} · {{ item.format }} · {{ formatPrice(item.lastUnitGross) }} con IVA en tu último
                  pedido
                </p>
                <p class="text-[13px] text-[var(--text-muted)]">
                  Lo pediste el {{ formatAccountDate(item.lastOrderedAt) }} ({{ item.lastQuantity }}
                  {{ item.lastQuantity === 1 ? 'ud' : 'uds' }})
                </p>
                <p v-if="errors[item.variantId]" role="alert" class="text-[13px] text-[var(--ui-error)]">
                  {{ errors[item.variantId] }}
                </p>
              </div>
              <div class="col-span-2 flex items-center gap-2 sm:col-span-1">
                <QuantityStepper v-model="quantities[item.variantId]!" :label="item.name" />
                <button
                  type="button"
                  data-habitual-add
                  :disabled="state[item.variantId] === 'adding'"
                  class="inline-flex h-11 flex-1 items-center justify-center rounded-[var(--radius-control)] px-4 text-[15px] font-semibold text-white transition-colors disabled:opacity-60 sm:flex-none"
                  :class="
                    state[item.variantId] === 'added'
                      ? 'bg-[var(--stock-ok)]'
                      : 'bg-[var(--action)] hover:bg-[var(--action-hover)]'
                  "
                  @click="add(item)"
                >
                  {{ state[item.variantId] === 'added' ? 'Añadido' : 'Añadir' }}
                </button>
              </div>
            </li>
          </ul>
          <p aria-live="polite" class="sr-only">{{ announcement }}</p>
        </div>
      </div>
    </div>
    <ReorderDialog ref="dialog" />
  </section>
</template>
