<script setup lang="ts">
import { useCartStore } from '~/stores/cart'

useSeoMeta({ title: 'Tramitar pedido' })

const cart = useCartStore()
const { loggedIn, user } = useUserSession()
const toast = useToast()

const form = reactive({
  name: '',
  company: '',
  nif: '',
  email: '',
  phone: '',
  address: '',
  zip: '',
  city: '',
  province: 'Valencia',
  notes: ''
})

watch(
  user,
  (u: any) => {
    if (!u) return
    form.name ||= u.name ?? ''
    form.email ||= u.email ?? ''
    form.phone ||= u.phone ?? ''
    form.company ||= u.company ?? ''
  },
  { immediate: true }
)

const shippingMethod = ref<'reparto' | 'envio' | 'recogida'>('reparto')
const paymentMethod = ref<'tarjeta' | 'bizum' | 'transferencia'>('tarjeta')
const card = reactive({ number: '', exp: '', cvc: '' })
const bizumPhone = ref('')
const acceptTerms = ref(false)

const shippingCost = computed(() =>
  shippingMethod.value === 'envio' && cart.subtotal < 15000 ? 590 : 0
)
const total = computed(() => cart.subtotal + shippingCost.value)
const tax = computed(() => total.value - Math.round(total.value / 1.21))

const submitting = ref(false)
const errorMsg = ref('')
const errors = reactive<Record<string, string>>({})
// si el pago con tarjeta/Bizum falla, reutilizamos el pedido creado para reintentar
const pendingOrder = ref<{ id: string; token: string } | null>(null)

// cambiar el método de pago, el envío o los datos invalida el pedido pendiente:
// el siguiente intento crea un pedido nuevo con la información correcta
watch([paymentMethod, shippingMethod, form], () => (pendingOrder.value = null), { deep: true })

const zipOutOfZone = computed(
  () =>
    shippingMethod.value === 'reparto' &&
    !!form.zip.trim() &&
    !form.zip.trim().startsWith(REPARTO_ZIP_PREFIX)
)

function validate() {
  Object.keys(errors).forEach((k) => delete errors[k])
  if (!form.name.trim()) errors.name = 'Indica el nombre completo'
  if (!form.email.trim()) errors.email = 'Indica el email'
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) errors.email = 'El email no parece válido'
  if (!form.phone.trim()) errors.phone = 'Indica un teléfono de contacto'
  if (!form.address.trim()) errors.address = 'Indica la dirección'
  if (!form.zip.trim()) errors.zip = 'Indica el código postal'
  else if (zipOutOfZone.value) errors.zip = 'CP fuera de la zona de reparto propio: elige «Envío por agencia»'
  if (!form.city.trim()) errors.city = 'Indica la población'
  if (paymentMethod.value === 'tarjeta') {
    const num = card.number.replace(/\s/g, '')
    if (!/^\d{13,19}$/.test(num)) errors.card = 'Introduce un número de tarjeta válido'
    else if (!/^\d{2}\s*\/?\s*\d{2}$/.test(card.exp.trim())) errors.card = 'Caducidad en formato MM/AA'
    else if (!/^\d{3,4}$/.test(card.cvc.trim())) errors.card = 'CVC de 3 o 4 dígitos'
  }
  if (paymentMethod.value === 'bizum' && bizumPhone.value.replace(/\D/g, '').length < 9) {
    errors.bizum = 'Introduce el teléfono asociado a Bizum'
  }
  if (!acceptTerms.value) errors.terms = 'Debes aceptar las condiciones para continuar'
  return Object.keys(errors).length === 0
}

function scrollTo(id: string, block: ScrollLogicalPosition = 'start') {
  nextTick(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block }))
}

function scrollToFirstError() {
  if (['name', 'email', 'phone', 'address', 'zip', 'city'].some((k) => errors[k])) scrollTo('sec-datos')
  else if (errors.card || errors.bizum) scrollTo('sec-pago')
  else scrollTo('checkout-alert', 'center')
}

async function submit() {
  errorMsg.value = ''
  if (!validate()) {
    errorMsg.value = 'Revisa los campos marcados.'
    scrollToFirstError()
    return
  }

  submitting.value = true
  try {
    let order = pendingOrder.value
    if (!order) {
      order = await $fetch<{ id: string; token: string }>('/api/orders', {
        method: 'POST',
        body: {
          customer: { ...form },
          shippingMethod: shippingMethod.value,
          paymentMethod: paymentMethod.value,
          items: cart.items.map((i) => ({ variantId: i.variantId, qty: i.qty }))
        }
      })
    }

    if (paymentMethod.value === 'transferencia') {
      finish(order)
      return
    }

    const pay = await $fetch<{ ok: boolean; error?: string }>('/api/checkout/pay', {
      method: 'POST',
      body: {
        orderId: order.id,
        token: order.token,
        method: paymentMethod.value,
        card: paymentMethod.value === 'tarjeta' ? { ...card } : undefined,
        bizumPhone: bizumPhone.value
      }
    })

    if (!pay.ok) {
      pendingOrder.value = order
      errorMsg.value = `${pay.error ?? 'No se ha podido completar el pago.'} Revisa los datos o elige otro método de pago.`
      scrollTo('checkout-alert', 'center')
      return
    }
    finish(order)
  } catch (e: any) {
    errorMsg.value =
      e?.data?.statusMessage ??
      e?.data?.message ??
      'No se ha podido crear el pedido. Vuelve a intentarlo o llámanos al 600 861 334.'
    scrollTo('checkout-alert', 'center')
  } finally {
    submitting.value = false
  }
}

function finish(order: { id: string; token: string }) {
  cart.clear()
  toast.add({ title: 'Pedido realizado', icon: 'i-lucide-check-circle-2', color: 'success' })
  navigateTo(`/pedido/${order.id}?token=${order.token}`)
}
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-4 py-8">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Tramitar pedido</h1>

    <ClientOnly>
      <div v-if="cart.items.length" class="mt-6 grid items-start gap-8 lg:grid-cols-3">
        <div class="space-y-6 lg:col-span-2">
          <!-- identificación -->
          <section v-if="!loggedIn" class="rounded-2xl border border-neteco-200 bg-neteco-50 p-5">
            <p class="flex items-center gap-2 font-medium text-neteco-900">
              <UIcon name="i-lucide-circle-user-round" class="size-5 text-neteco-600" />
              Estás comprando como invitado
            </p>
            <p class="mt-1 text-sm text-neteco-800">
              No necesitas cuenta para terminar el pedido. Si ya tienes una,
              <NuxtLink to="/login?redirect=/checkout" class="font-semibold underline">inicia sesión</NuxtLink>
              para rellenar tus datos automáticamente y ver tu historial.
            </p>
          </section>
          <section v-else class="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <p class="flex items-center gap-2 text-sm font-medium text-emerald-800">
              <UIcon name="i-lucide-check-circle-2" class="size-5" />
              Comprando con tu cuenta: {{ (user as any)?.email }}
            </p>
          </section>

          <!-- datos -->
          <section id="sec-datos" class="scroll-mt-40 rounded-2xl border border-slate-200 bg-white p-6">
            <h2 class="flex items-center gap-2 text-lg font-bold text-slate-900">
              <span class="flex size-7 items-center justify-center rounded-full bg-neteco-600 text-sm font-bold text-white">1</span>
              Datos de facturación y entrega
            </h2>
            <div class="mt-5 grid gap-4 sm:grid-cols-2">
              <UFormField label="Nombre y apellidos" required :error="errors.name">
                <UInput v-model="form.name" class="w-full" autocomplete="name" />
              </UFormField>
              <UFormField label="Empresa" hint="opcional">
                <UInput v-model="form.company" class="w-full" autocomplete="organization" />
              </UFormField>
              <UFormField label="NIF / CIF" hint="opcional">
                <UInput v-model="form.nif" class="w-full" />
              </UFormField>
              <UFormField label="Teléfono" required :error="errors.phone">
                <UInput v-model="form.phone" type="tel" inputmode="tel" class="w-full" autocomplete="tel" />
              </UFormField>
              <UFormField label="Email" required class="sm:col-span-2" :error="errors.email">
                <UInput v-model="form.email" type="email" class="w-full" autocomplete="email" />
              </UFormField>
              <UFormField label="Dirección" required class="sm:col-span-2" :error="errors.address">
                <UInput v-model="form.address" class="w-full" autocomplete="street-address" />
              </UFormField>
              <UFormField label="Código postal" required :error="errors.zip">
                <UInput v-model="form.zip" inputmode="numeric" class="w-full" autocomplete="postal-code" />
              </UFormField>
              <UFormField label="Población" required :error="errors.city">
                <UInput v-model="form.city" class="w-full" autocomplete="address-level2" />
              </UFormField>
              <UFormField label="Provincia">
                <UInput v-model="form.province" class="w-full" autocomplete="address-level1" />
              </UFormField>
              <UFormField label="Notas para el reparto" hint="opcional">
                <UInput v-model="form.notes" placeholder="Horario, muelle de carga…" class="w-full" />
              </UFormField>
            </div>
          </section>

          <!-- entrega -->
          <section class="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 class="flex items-center gap-2 text-lg font-bold text-slate-900">
              <span class="flex size-7 items-center justify-center rounded-full bg-neteco-600 text-sm font-bold text-white">2</span>
              Método de entrega
            </h2>
            <div class="mt-5 space-y-2">
              <label
                v-for="m in SHIPPING_METHODS"
                :key="m.value"
                class="flex cursor-pointer items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 transition"
                :class="shippingMethod === m.value ? 'border-neteco-500 ring-1 ring-neteco-500' : 'border-slate-200 hover:border-neteco-300'"
              >
                <span class="flex items-center gap-3">
                  <input v-model="shippingMethod" type="radio" :value="m.value" class="accent-neteco-500" >
                  <span>
                    <span class="block font-medium text-slate-800">{{ m.label }}</span>
                    <span class="block text-xs text-slate-500">{{ m.desc }}</span>
                  </span>
                </span>
                <span class="font-semibold text-slate-800">
                  {{ m.value === 'envio' ? (cart.subtotal >= 15000 ? 'Gratis' : formatPrice(m.price)) : 'Gratis' }}
                </span>
              </label>
            </div>
            <p v-if="zipOutOfZone" class="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0" />
              Tu código postal está fuera de nuestra zona de reparto propio (Ontinyent y la Vall d'Albaida). Elige «Envío por agencia».
            </p>
          </section>

          <!-- pago -->
          <section id="sec-pago" class="scroll-mt-40 rounded-2xl border border-slate-200 bg-white p-6">
            <h2 class="flex items-center gap-2 text-lg font-bold text-slate-900">
              <span class="flex size-7 items-center justify-center rounded-full bg-neteco-600 text-sm font-bold text-white">3</span>
              Pago
            </h2>
            <div class="mt-5 space-y-2">
              <label
                class="flex cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 transition"
                :class="paymentMethod === 'tarjeta' ? 'border-neteco-500 ring-1 ring-neteco-500' : 'border-slate-200 hover:border-neteco-300'"
              >
                <input v-model="paymentMethod" type="radio" value="tarjeta" class="accent-neteco-500" >
                <UIcon name="i-lucide-credit-card" class="size-5 text-slate-500" />
                <span class="font-medium text-slate-800">Tarjeta de crédito / débito</span>
              </label>
              <div v-if="paymentMethod === 'tarjeta'" class="ml-2 grid gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-4">
                <UFormField label="Número de tarjeta" class="sm:col-span-2">
                  <UInput v-model="card.number" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242" class="w-full" />
                </UFormField>
                <UFormField label="Caducidad">
                  <UInput v-model="card.exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/AA" class="w-full" />
                </UFormField>
                <UFormField label="CVC">
                  <UInput v-model="card.cvc" inputmode="numeric" autocomplete="cc-csc" placeholder="123" class="w-full" />
                </UFormField>
                <p v-if="errors.card" class="text-sm font-medium text-red-600 sm:col-span-4">{{ errors.card }}</p>
                <p class="text-xs text-slate-500 sm:col-span-4">
                  <UIcon name="i-lucide-info" class="inline size-3.5" />
                  Pasarela simulada para la demo: cualquier tarjeta funciona; una terminada en <b>0000</b> simula un rechazo del banco.
                </p>
              </div>

              <label
                class="flex cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 transition"
                :class="paymentMethod === 'bizum' ? 'border-neteco-500 ring-1 ring-neteco-500' : 'border-slate-200 hover:border-neteco-300'"
              >
                <input v-model="paymentMethod" type="radio" value="bizum" class="accent-neteco-500" >
                <UIcon name="i-lucide-smartphone" class="size-5 text-slate-500" />
                <span class="font-medium text-slate-800">Bizum</span>
              </label>
              <div v-if="paymentMethod === 'bizum'" class="ml-2 rounded-xl bg-slate-50 p-4">
                <UFormField label="Teléfono asociado a Bizum" :error="errors.bizum">
                  <UInput v-model="bizumPhone" type="tel" inputmode="tel" placeholder="600 000 000" class="w-full sm:w-64" />
                </UFormField>
              </div>

              <label
                class="flex cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 transition"
                :class="paymentMethod === 'transferencia' ? 'border-neteco-500 ring-1 ring-neteco-500' : 'border-slate-200 hover:border-neteco-300'"
              >
                <input v-model="paymentMethod" type="radio" value="transferencia" class="accent-neteco-500" >
                <UIcon name="i-lucide-landmark" class="size-5 text-slate-500" />
                <span>
                  <span class="block font-medium text-slate-800">Transferencia bancaria</span>
                  <span class="block text-xs text-slate-500">El pedido se prepara al recibir el ingreso</span>
                </span>
              </label>
            </div>
          </section>
        </div>

        <!-- resumen lateral -->
        <aside class="sticky top-40 rounded-2xl border border-slate-200 bg-white p-6">
          <div class="flex items-baseline justify-between">
            <h2 class="text-lg font-bold text-slate-900">Tu pedido</h2>
            <NuxtLink to="/carrito" class="text-sm font-medium text-neteco-600 hover:text-neteco-500">Editar</NuxtLink>
          </div>
          <ul class="mt-4 max-h-64 space-y-3 overflow-y-auto pr-1">
            <li v-for="item in cart.items" :key="item.variantId" class="flex items-center gap-3">
              <div class="w-10 shrink-0"><ProductImage :product="item" /></div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-slate-700">{{ item.name }}</p>
                <p class="text-xs text-slate-500">{{ item.format }} × {{ item.qty }}</p>
              </div>
              <p class="text-sm font-semibold">{{ formatPrice(item.price * item.qty) }}</p>
            </li>
          </ul>
          <dl class="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm">
            <div class="flex justify-between"><dt class="text-slate-500">Subtotal</dt><dd>{{ formatPrice(cart.subtotal) }}</dd></div>
            <div class="flex justify-between gap-3">
              <dt class="min-w-0 truncate text-slate-500">
                Envío · {{ SHIPPING_METHODS.find((m) => m.value === shippingMethod)?.label }}
              </dt>
              <dd class="shrink-0">{{ shippingCost ? formatPrice(shippingCost) : 'Gratis' }}</dd>
            </div>
            <div class="flex justify-between text-xs text-slate-500">
              <dt>IVA incluido (21 %)</dt><dd>{{ formatPrice(tax) }}</dd>
            </div>
            <div class="flex justify-between border-t border-slate-100 pt-3">
              <dt class="text-base font-semibold">Total</dt>
              <dd class="text-xl font-bold">{{ formatPrice(total) }}</dd>
            </div>
          </dl>

          <label class="mt-4 flex items-start gap-2 text-xs text-slate-500">
            <input v-model="acceptTerms" type="checkbox" class="mt-0.5 accent-neteco-600" >
            <span>
              Acepto las
              <a href="https://neteco.es/legal" target="_blank" rel="noopener" class="underline hover:text-neteco-600">condiciones de compra</a>
              y la
              <a href="https://neteco.es/legal" target="_blank" rel="noopener" class="underline hover:text-neteco-600">política de privacidad</a>
              de NETECO.
            </span>
          </label>
          <p v-if="errors.terms" class="mt-1.5 text-xs font-medium text-red-600">{{ errors.terms }}</p>

          <div v-if="errorMsg" id="checkout-alert" role="alert" class="mt-4 scroll-mt-40">
            <UAlert color="error" variant="subtle" icon="i-lucide-alert-circle" :title="errorMsg" />
          </div>

          <UButton
            size="xl"
            block
            class="mt-4"
            :loading="submitting"
            icon="i-lucide-lock"
            @click="submit"
          >
            {{ paymentMethod === 'transferencia' ? 'Confirmar pedido' : `Pagar ${formatPrice(total)}` }}
          </UButton>
          <p class="mt-3 flex items-center justify-center gap-1.5 text-xs text-slate-400">
            <UIcon name="i-lucide-shield-check" class="size-3.5" /> Demo: no se realiza ningún cargo real
          </p>
        </aside>
      </div>

      <div v-else class="py-20 text-center">
        <UIcon name="i-lucide-shopping-cart" class="mx-auto size-14 text-slate-300" />
        <p class="mt-4 text-lg font-medium text-slate-600">Tu carrito está vacío</p>
        <p class="mt-1 text-sm text-slate-500">Añade productos del catálogo para tramitar tu pedido.</p>
        <UButton to="/catalogo" size="lg" class="mt-6" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
      </div>

      <template #fallback>
        <div class="py-20 text-center text-slate-400">Cargando…</div>
      </template>
    </ClientOnly>
  </div>
</template>
