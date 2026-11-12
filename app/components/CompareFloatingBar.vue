<script setup lang="ts">
/**
 * Salida visible de «Añadir a comparar»: un botón flotante «Comparar (n)» que acompaña al
 * visitante por toda la tienda mientras tenga productos marcados y lleva al comparador.
 *
 * La selección vive en el navegador (misma clave que `CompareToggle` y `/comparar`), así
 * que solo se pinta tras montar. En móvil se coloca por encima de la barra inferior o de
 * la barra de compra fija de la ficha y el carrito.
 */
const COMPARE_STORAGE_KEY = 'neteco_compare_slugs'
const MAXIMUM = 4

const route = useRoute()
const count = ref(0)

function read(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COMPARE_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((slug): slug is string => typeof slug === 'string') : []
  } catch {
    return []
  }
}
function sync() {
  count.value = read().length
}
function clear() {
  try {
    localStorage.setItem(COMPARE_STORAGE_KEY, '[]')
    window.dispatchEvent(new Event('neteco_compare_updated'))
  } catch {
    // Sin almacenamiento no hay selección que vaciar.
  }
  sync()
}

onMounted(() => {
  sync()
  window.addEventListener('neteco_compare_updated', sync)
  window.addEventListener('storage', sync)
})
onBeforeUnmount(() => {
  window.removeEventListener('neteco_compare_updated', sync)
  window.removeEventListener('storage', sync)
})

const hidden = computed(() =>
  ['/comparar', '/checkout', '/pago', '/admin', '/reparto'].some(
    (prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`)
  )
)
/** Ficha y carrito tienen su propia barra de compra fija en móvil, más alta que la de accesos. */
const raised = computed(() => ['/producto', '/carrito'].some((prefix) => route.path.startsWith(prefix)))
</script>

<template>
  <Transition
    enter-active-class="transition duration-200"
    enter-from-class="translate-y-3 opacity-0"
    leave-active-class="transition duration-150"
    leave-to-class="translate-y-3 opacity-0"
  >
    <div
      v-if="count > 0 && !hidden"
      data-compare-bar
      role="region"
      aria-label="Comparador de productos"
      class="fixed right-3 z-40 flex items-center gap-1 rounded-full bg-neteco-950 py-1.5 pl-1.5 pr-1.5 text-white shadow-[var(--shadow-overlay)] ring-1 ring-white/20 sm:right-6 lg:bottom-6"
      :class="raised ? 'bottom-28' : 'bottom-[4.5rem]'"
    >
      <NuxtLink
        to="/comparar"
        class="flex h-11 items-center gap-2 rounded-full bg-white pl-3 pr-4 text-[15px] font-semibold text-neteco-950 transition-colors hover:bg-neteco-50"
      >
        <UIcon name="i-lucide-columns-2" class="size-5" aria-hidden="true" />
        Comparar
        <span
          class="tabular grid h-6 min-w-6 place-items-center rounded-full bg-[var(--action)] px-1.5 text-[13px] font-bold text-white"
          :aria-label="`${count} de ${MAXIMUM} productos`"
          >{{ count }}</span
        >
      </NuxtLink>
      <button
        type="button"
        class="grid size-11 place-items-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
        aria-label="Vaciar la comparación"
        title="Vaciar la comparación"
        @click="clear"
      >
        <UIcon name="i-lucide-x" class="size-5" />
      </button>
    </div>
  </Transition>
</template>
