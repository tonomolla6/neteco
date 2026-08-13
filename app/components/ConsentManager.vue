<script setup lang="ts">
const { preferences, acceptAll, rejectOptional, save } = useConsent()
const runtime = useRuntimeConfig()
const visible = ref(!preferences.value)
const configuring = ref(false)
const analytics = ref(preferences.value?.analytics ?? false)
const marketing = ref(preferences.value?.marketing ?? false)
const dialog = ref<HTMLElement | null>(null)

function open() {
  analytics.value = preferences.value?.analytics ?? false
  marketing.value = preferences.value?.marketing ?? false
  configuring.value = true
  visible.value = true
}

function accept() {
  acceptAll()
  visible.value = false
}

function reject() {
  rejectOptional()
  visible.value = false
}

function saveSelection() {
  save({ analytics: analytics.value, marketing: marketing.value })
  visible.value = false
}

onMounted(() => window.addEventListener('neteco-open-consent', open))
onBeforeUnmount(() => window.removeEventListener('neteco-open-consent', open))

watch(
  visible,
  (shown) => {
    if (shown) nextTick(() => dialog.value?.querySelector<HTMLElement>('button')?.focus())
  },
  { immediate: true }
)

function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialog.value) return
  const focusable = [...dialog.value.querySelectorAll<HTMLElement>('button, a[href], input:not([disabled])')]
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
</script>

<template>
  <section
    v-if="visible"
    ref="dialog"
    class="fixed inset-x-3 bottom-3 z-[90] mx-auto max-w-3xl rounded-2xl border border-slate-300 bg-white p-5 shadow-2xl"
    role="dialog"
    aria-modal="true"
    aria-labelledby="consent-title"
    @keydown="trapFocus"
  >
    <h2 id="consent-title" class="font-bold text-slate-950">Tu privacidad, bajo tu control</h2>
    <p class="mt-2 text-sm leading-relaxed text-slate-600">
      Las cookies necesarias mantienen la sesión y el carrito. La medición y el marketing son opcionales, permanecen
      apagados hasta que los aceptes y puedes cambiar tu decisión cuando quieras.
      <a :href="runtime.public.cookiesUrl" target="_blank" rel="noopener" class="font-medium text-neteco-700 underline"
        >Ver política de cookies</a
      >.
    </p>

    <div v-if="configuring" class="mt-4 space-y-3 rounded-xl bg-slate-50 p-4">
      <label class="flex items-start gap-3 text-sm"
        ><input type="checkbox" checked disabled class="mt-0.5 size-4" /><span
          ><strong>Necesarias</strong><br /><span class="text-slate-500"
            >Seguridad, sesión, carrito y preferencias esenciales.</span
          ></span
        ></label
      >
      <label class="flex items-start gap-3 text-sm"
        ><input v-model="analytics" type="checkbox" class="mt-0.5 size-4" /><span
          ><strong>Medición</strong><br /><span class="text-slate-500"
            >Ayuda a detectar fricción y errores sin enviar datos personales.</span
          ></span
        ></label
      >
      <label class="flex items-start gap-3 text-sm"
        ><input v-model="marketing" type="checkbox" class="mt-0.5 size-4" /><span
          ><strong>Marketing</strong><br /><span class="text-slate-500"
            >Permite campañas y atribución no esenciales cuando se configuren proveedores.</span
          ></span
        ></label
      >
    </div>

    <div class="mt-4 flex flex-wrap gap-2">
      <UButton color="neutral" variant="outline" @click="reject">Rechazar opcionales</UButton>
      <UButton v-if="!configuring" color="neutral" variant="outline" @click="configuring = true">Configurar</UButton>
      <UButton v-else @click="saveSelection">Guardar selección</UButton>
      <UButton v-if="!configuring" @click="accept">Aceptar todas</UButton>
    </div>
  </section>
</template>
