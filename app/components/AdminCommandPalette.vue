<script setup lang="ts">
import type { AdminNavigationLink } from '~~/shared/admin-navigation'
const props = defineProps<{ groups: Array<{ label: string; links: AdminNavigationLink[] }>; enabled: boolean }>()
const prefix = useId()
const trigger = ref<HTMLButtonElement | null>(null),
  dialog = ref<HTMLElement | null>(null),
  input = ref<HTMLInputElement | null>(null)
const opened = ref(false),
  query = ref(''),
  selected = ref(0),
  navigating = ref(false),
  error = ref('')
let alive = true,
  focusGeneration = 0
function normalize(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es-ES').trim()
}
const destinations = computed(() => {
  if (!props.enabled) return []
  const seen = new Set<string>()
  return props.groups
    .flatMap((group) => group.links.map((link) => ({ ...link, category: group.label })))
    .filter((link) => {
      // The parent supplies authority. This only confines navigation to real
      // internal admin paths; it does not invent grants or add missing links.
      if (!/^\/admin(?:\/[a-z0-9-]+)*$/.test(link.to) || !link.label.trim() || seen.has(link.to)) return false
      seen.add(link.to)
      return true
    })
})
const available = computed(() => props.enabled && destinations.value.length > 0)
const authorityKey = computed(() =>
  JSON.stringify(destinations.value.map((link) => [link.to, link.label, link.category]))
)
const matches = computed(() => {
  const terms = normalize(query.value).split(/\s+/u).filter(Boolean)
  return destinations.value.filter((link) => {
    const text = normalize(link.label + ' ' + link.category)
    return terms.every((term) => text.includes(term))
  })
})
const activeOption = computed(() => (matches.value.length > 0 ? `${prefix}-option-${selected.value}` : undefined))
function close() {
  const wasOpened = opened.value
  const generation = ++focusGeneration
  opened.value = false
  query.value = ''
  selected.value = 0
  void nextTick(() => {
    if (
      wasOpened &&
      alive &&
      generation === focusGeneration &&
      !opened.value &&
      trigger.value?.isConnected &&
      !trigger.value.disabled
    )
      trigger.value.focus()
  })
}
function open() {
  if (!alive || !available.value || navigating.value) return
  if (opened.value) return
  const generation = ++focusGeneration
  error.value = ''
  query.value = ''
  selected.value = 0
  opened.value = true
  void nextTick(() => {
    if (alive && generation === focusGeneration && opened.value && available.value) input.value?.focus()
  })
}
watch(
  authorityKey,
  () => {
    close()
    error.value = ''
  },
  { flush: 'sync' }
)
watch(
  query,
  () => {
    selected.value = 0
  },
  { flush: 'sync' }
)
function scrollSelection() {
  void nextTick(() => {
    if (!alive || !opened.value || !activeOption.value) return
    dialog.value?.querySelector<HTMLElement>(`[id="${activeOption.value}"]`)?.scrollIntoView?.({ block: 'nearest' })
  })
}
function searchKey(event: KeyboardEvent) {
  if (event.isComposing || !opened.value || !available.value) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const total = matches.value.length
    if (!total) return
    selected.value = (selected.value + (event.key === 'ArrowDown' ? 1 : -1) + total) % total
    scrollSelection()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const link = matches.value[selected.value]
    if (link) void choose(link.to)
  }
}
async function choose(to: string) {
  if (!alive || !opened.value || !available.value || navigating.value || !matches.value.some((link) => link.to === to))
    return
  const owner = authorityKey.value
  navigating.value = true
  close()
  try {
    await navigateTo(to)
  } catch {
    if (alive && props.enabled && authorityKey.value === owner)
      error.value = 'No se ha podido abrir la sección. Puedes volver a intentarlo.'
  } finally {
    if (alive) navigating.value = false
  }
}
function trapFocus(event: KeyboardEvent) {
  const controls = Array.from(
    dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])') ?? []
  ).filter((control) => control.tabIndex >= 0)
  const first = controls[0],
    last = controls.at(-1)
  if (!first || !last) return
  const current = document.activeElement
  if (!controls.includes(current as HTMLElement)) {
    event.preventDefault()
    first.focus()
  } else if (!event.shiftKey && current === last) {
    event.preventDefault()
    first.focus()
  } else if (event.shiftKey && current === first) {
    event.preventDefault()
    last.focus()
  }
}
function globalKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return
  if (
    event.key.toLowerCase() === 'k' &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat
  ) {
    if (!available.value || navigating.value) return
    event.preventDefault()
    if (opened.value) close()
    else open()
  } else if (opened.value && event.key === 'Escape') {
    event.preventDefault()
    close()
  } else if (opened.value && event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) trapFocus(event)
}
onMounted(() => window.addEventListener('keydown', globalKey))
onBeforeUnmount(() => {
  alive = false
  focusGeneration++
  window.removeEventListener('keydown', globalKey)
})
</script>
<template>
  <div class="min-w-0">
    <button
      ref="trigger"
      data-palette-open
      type="button"
      :disabled="!available || navigating"
      aria-label="Buscar sección del panel"
      aria-keyshortcuts="Control+K Meta+K"
      :aria-expanded="opened"
      :aria-controls="prefix + '-dialog'"
      class="inline-flex h-9 w-full max-w-md items-center gap-2 rounded-[var(--radius-control)] border border-white/15 bg-white/10 px-3 text-sm text-slate-200 transition-colors hover:bg-white/15 disabled:opacity-50"
      @click="open"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="size-4 shrink-0"
      >
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </svg>
      <span class="sr-only sm:not-sr-only sm:flex-1 sm:truncate sm:text-left">Ir a una sección…</span
      ><kbd class="hidden shrink-0 rounded border border-white/20 px-1.5 text-[11px] text-slate-300 sm:inline">Ctrl K</kbd>
    </button>
    <p v-if="error" role="alert" class="text-sm">{{ error }}</p>
    <div
      v-if="opened"
      data-palette-overlay
      class="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 p-3 pt-12 sm:pt-20"
      @click.self="close"
    >
      <section
        :id="prefix + '-dialog'"
        ref="dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="prefix + '-title'"
        :aria-describedby="prefix + '-hint'"
        class="flex max-h-[calc(100dvh-6rem)] w-full min-w-0 max-w-xl flex-col overflow-hidden rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-xl"
      >
        <header class="flex shrink-0 items-center justify-between gap-3 px-4 pt-4">
          <h2 :id="prefix + '-title'" class="min-w-0 font-semibold">Ir a una sección del panel</h2>
          <button
            data-palette-close
            type="button"
            aria-label="Cerrar búsqueda de secciones"
            class="shrink-0 rounded border px-3 py-2"
            @click="close"
          >
            Cerrar
          </button>
        </header>
        <div class="shrink-0 space-y-2 p-4">
          <label :for="prefix + '-query'" class="block text-sm font-medium">Buscar por nombre o categoría</label>
          <input
            :id="prefix + '-query'"
            ref="input"
            v-model="query"
            data-palette-query
            type="search"
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="opened"
            :aria-controls="prefix + '-results'"
            :aria-activedescendant="activeOption"
            :aria-describedby="prefix + '-hint'"
            maxlength="160"
            autocomplete="off"
            class="block w-full min-w-0 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] p-2"
            @keydown="searchKey"
          />
          <p :id="prefix + '-hint'" class="text-xs text-[var(--text-muted)]">
            Busca secciones, no datos privados. Usa ↑ y ↓ para elegir, enter para abrir y escape para cerrar.
          </p>
        </div>
        <p v-if="!matches.length" data-palette-empty role="status" class="px-4 pb-4">
          No hay destinos autorizados que coincidan con esta búsqueda.
        </p>
        <ul
          :id="prefix + '-results'"
          data-palette-results
          role="listbox"
          aria-label="Secciones autorizadas"
          class="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden break-words px-2 pb-3 [overflow-wrap:anywhere]"
        >
          <li v-for="(link, index) in matches" :key="link.to" role="none">
            <button
              :id="prefix + '-option-' + index"
              type="button"
              role="option"
              :aria-selected="index === selected"
              tabindex="-1"
              class="flex w-full min-w-0 flex-col rounded-[var(--radius-control)] px-3 py-3 text-left"
              :class="index === selected ? 'bg-neteco-50 text-neteco-800' : 'hover:bg-[var(--surface-sunken)]'"
              @click="choose(link.to)"
            >
              <span class="font-medium">{{ link.label }}</span
              ><span class="text-xs text-[var(--text-muted)]">{{ link.category }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
