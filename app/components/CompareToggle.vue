<script setup lang="ts">
/**
 * Añadir o quitar un producto de la comparación (máximo cuatro, guardados en el navegador).
 * En consumibles comparar es un uso minoritario: vive en la fila de escritorio y en la
 * ficha, no encima de la foto de cada tarjeta.
 */
const props = withDefaults(defineProps<{ slug: string; name: string; withLabel?: boolean }>(), { withLabel: false })

const COMPARE_STORAGE_KEY = 'neteco_compare_slugs'
const isCompared = ref(false)

function read(): string[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(COMPARE_STORAGE_KEY) : null
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
function write(slugs: string[]) {
  try {
    localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(slugs))
    window.dispatchEvent(new Event('neteco_compare_updated'))
  } catch {
    // Sin almacenamiento disponible la comparación simplemente no se guarda.
  }
}
function sync() {
  isCompared.value = read().includes(props.slug)
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
function toggle() {
  const current = read()
  if (current.includes(props.slug)) {
    write(current.filter((slug) => slug !== props.slug))
    isCompared.value = false
  } else if (current.length < 4) {
    write([...current, props.slug])
    isCompared.value = true
  }
}
</script>

<template>
  <button
    type="button"
    :aria-pressed="isCompared"
    :aria-label="isCompared ? `Quitar ${name} de comparar` : `Comparar ${name}`"
    :title="isCompared ? 'Quitar de comparar' : 'Añadir a comparar (máx. 4)'"
    class="inline-flex h-9 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border text-[13px] font-medium transition-colors"
    :class="[
      withLabel ? 'px-3' : 'w-9',
      isCompared
        ? 'border-[var(--action)] bg-neteco-50 text-[var(--action)]'
        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text-strong)]'
    ]"
    @click="toggle"
  >
    <UIcon :name="isCompared ? 'i-lucide-check' : 'i-lucide-columns-2'" class="size-4" />
    <span v-if="withLabel">{{ isCompared ? 'Comparando' : 'Comparar' }}</span>
  </button>
</template>
