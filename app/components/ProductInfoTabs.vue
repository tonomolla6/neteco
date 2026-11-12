<script setup lang="ts">
/**
 * Información de la ficha en pestañas (escritorio) y acordeón (móvil), con un solo DOM: cada
 * sección se pinta una vez y el CSS decide cómo se ve en cada tamaño. Así un bloque que pide
 * datos (opiniones, avisos) no se monta dos veces.
 *
 * Escritorio: patrón «tabs» de WAI-ARIA con activación automática; flechas, Inicio y Fin.
 * Móvil: cada sección es un botón con `aria-expanded`; la primera empieza abierta.
 */
export interface ProductInfoTab {
  id: string
  label: string
  /** Cifra real que acompaña a la etiqueta, p. ej. número de opiniones. */
  count?: number | null
}

const props = defineProps<{ tabs: ProductInfoTab[] }>()
const uid = useId()
const active = ref(props.tabs[0]?.id ?? '')
const open = ref(new Set<string>(props.tabs[0] ? [props.tabs[0].id] : []))
const root = useTemplateRef<HTMLElement>('root')

watch(
  () => props.tabs.map((tab) => tab.id).join('|'),
  () => {
    if (!props.tabs.some((tab) => tab.id === active.value)) active.value = props.tabs[0]?.id ?? ''
  }
)

function toggle(id: string) {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
  active.value = id
}
function tabKeydown(event: KeyboardEvent, index: number) {
  const count = props.tabs.length
  const targets: Record<string, number> = {
    ArrowRight: (index + 1) % count,
    ArrowLeft: (index - 1 + count) % count,
    Home: 0,
    End: count - 1
  }
  const target = targets[event.key]
  if (target === undefined) return
  event.preventDefault()
  active.value = props.tabs[target]!.id
  document.getElementById(`${uid}-tab-${props.tabs[target]!.id}`)?.focus()
}

/** Abre una sección desde fuera («Ver ficha de seguridad», «3 opiniones») y la lleva a la vista. */
function show(id: string) {
  if (!props.tabs.some((tab) => tab.id === id)) return
  active.value = id
  open.value = new Set([...open.value, id])
  void nextTick(() => root.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}
defineExpose({ show })

const label = (tab: ProductInfoTab) => (tab.count ? `${tab.label} (${tab.count})` : tab.label)
</script>

<template>
  <section ref="root" data-product-tabs class="min-w-0 scroll-mt-24" aria-label="Información del producto">
    <div
      role="tablist"
      aria-label="Información del producto"
      class="scrollbar-none hidden gap-1 overflow-x-auto overflow-y-hidden border-b border-[var(--border)] lg:flex"
    >
      <button
        v-for="(tab, index) in tabs"
        :id="`${uid}-tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="active === tab.id"
        :aria-controls="`${uid}-panel-${tab.id}`"
        :tabindex="active === tab.id ? 0 : -1"
        class="-mb-px min-h-12 shrink-0 whitespace-nowrap border-b-2 px-4 text-[15px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--action)]"
        :class="
          active === tab.id
            ? 'border-[var(--action)] text-[var(--text-strong)]'
            : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-strong)]'
        "
        @click="active = tab.id"
        @keydown="tabKeydown($event, index)"
      >
        {{ label(tab) }}
      </button>
    </div>

    <div class="divide-y divide-[var(--border)] border-y border-[var(--border)] lg:divide-y-0 lg:border-0">
      <div v-for="tab in tabs" :key="tab.id">
        <h2 class="lg:hidden">
          <button
            :id="`${uid}-acc-${tab.id}`"
            type="button"
            :aria-expanded="open.has(tab.id)"
            :aria-controls="`${uid}-panel-${tab.id}`"
            class="flex min-h-14 w-full items-center justify-between gap-3 py-3 text-left text-base font-semibold text-[var(--text-strong)]"
            @click="toggle(tab.id)"
          >
            {{ label(tab) }}
            <UIcon
              name="i-lucide-chevron-down"
              class="size-5 shrink-0 text-[var(--text-muted)] transition-transform"
              :class="open.has(tab.id) ? 'rotate-180' : ''"
              aria-hidden="true"
            />
          </button>
        </h2>
        <div
          :id="`${uid}-panel-${tab.id}`"
          role="tabpanel"
          :aria-labelledby="`${uid}-tab-${tab.id}`"
          tabindex="0"
          class="min-w-0 pb-5 focus-visible:outline-none lg:pb-0 lg:pt-6"
          :class="[open.has(tab.id) ? 'block' : 'hidden', active === tab.id ? 'lg:block' : 'lg:hidden']"
        >
          <slot :name="tab.id" />
        </div>
      </div>
    </div>
  </section>
</template>
