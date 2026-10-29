<script setup lang="ts" generic="T extends Record<string, any>">
/**
 * Tabla operativa del panel.
 *
 * Las tablas anteriores (`/admin/pedidos`, `/admin/clientes`, `/admin/devoluciones`…)
 * no tenían búsqueda, ni filtros, ni orden, ni paginación, ni selección múltiple,
 * ni recuento. Con 14 pedidos de demo no se notaba; con el catálogo real son
 * inoperables. Este componente concentra ese comportamiento en un sitio para que
 * ninguna pantalla lo vuelva a improvisar.
 *
 * Deliberadamente NO acepta controles editables dentro de las celdas. Cambiar el
 * estado de un pedido es una acción de negocio con consecuencias contables: va en
 * el detalle o en una acción masiva con confirmación, nunca en un `<select>` suelto
 * que se dispara con la rueda del ratón.
 */
export interface Column<Row> {
  key: string
  label: string
  /** Alinea a la derecha y activa cifras tabulares. Para importes y cantidades. */
  numeric?: boolean
  sortable?: boolean
  /** Oculta la columna en móvil, donde la fila se pinta como tarjeta. */
  hideOnMobile?: boolean
  value?: (row: Row) => unknown
}

const props = withDefaults(
  defineProps<{
    rows: T[]
    columns: Column<T>[]
    rowKey: (row: T) => string
    status?: 'idle' | 'pending' | 'error'
    /** Total de servidor. Si falta, se pagina en cliente sobre `rows`. */
    total?: number
    page?: number
    perPage?: number
    searchable?: boolean
    searchPlaceholder?: string
    selectable?: boolean
    emptyTitle?: string
    emptyDescription?: string
    errorMessage?: string
  }>(),
  {
    status: 'idle',
    total: undefined,
    emptyDescription: undefined,
    page: 1,
    perPage: 25,
    searchable: true,
    searchPlaceholder: 'Buscar…',
    selectable: false,
    emptyTitle: 'No hay nada aquí todavía',
    errorMessage: 'No hemos podido cargar estos datos.'
  }
)

const emit = defineEmits<{
  'update:page': [number]
  search: [string]
  sort: [{ key: string; direction: 'asc' | 'desc' }]
  retry: []
}>()

const search = ref('')
const sortKey = ref<string>('')
const sortDir = ref<'asc' | 'desc'>('asc')
const selected = defineModel<string[]>('selected', { default: () => [] })

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, (value) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => emit('search', value.trim()), 250)
})

function toggleSort(column: Column<T>) {
  if (!column.sortable) return
  if (sortKey.value === column.key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = column.key
    sortDir.value = 'asc'
  }
  emit('sort', { key: sortKey.value, direction: sortDir.value })
}

const totalRows = computed(() => props.total ?? props.rows.length)
const pageCount = computed(() => Math.max(1, Math.ceil(totalRows.value / props.perPage)))
const allSelected = computed(() => props.rows.length > 0 && selected.value.length === props.rows.length)

function toggleAll() {
  selected.value = allSelected.value ? [] : props.rows.map((row) => props.rowKey(row))
}
function toggleRow(id: string) {
  selected.value = selected.value.includes(id) ? selected.value.filter((item) => item !== id) : [...selected.value, id]
}

function cellValue(row: T, column: Column<T>) {
  return column.value ? column.value(row) : row[column.key]
}

const rangeFrom = computed(() => (totalRows.value === 0 ? 0 : (props.page - 1) * props.perPage + 1))
const rangeTo = computed(() => Math.min(props.page * props.perPage, totalRows.value))
</script>

<template>
  <div class="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)]">
    <!-- Barra de herramientas: buscar, filtros, y acciones masivas cuando hay selección -->
    <div
      v-if="searchable || $slots.filters || $slots['bulk-actions']"
      class="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-3"
    >
      <template v-if="selectable && selected.length">
        <p class="text-sm font-semibold text-[var(--text-strong)]">
          {{ selected.length }} seleccionado{{ selected.length === 1 ? '' : 's' }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <slot name="bulk-actions" :selected="selected" />
        </div>
        <UButton size="xs" color="neutral" variant="ghost" @click="selected = []">Quitar selección</UButton>
      </template>

      <template v-else>
        <UInput
          v-if="searchable"
          v-model="search"
          icon="i-lucide-search"
          :placeholder="searchPlaceholder"
          class="w-full sm:w-72"
        >
          <template v-if="search" #trailing>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-x"
              aria-label="Borrar búsqueda"
              @click="search = ''"
            />
          </template>
        </UInput>
        <slot name="filters" />
        <div class="ml-auto flex items-center gap-2">
          <slot name="toolbar" />
        </div>
      </template>
    </div>

    <!-- Carga: esqueletos en el sitio donde estarán los datos, no un splash de marca -->
    <div v-if="status === 'pending'" class="divide-y divide-[var(--border)]">
      <div v-for="row in 6" :key="row" class="flex items-center gap-4 px-4 py-4">
        <div class="h-4 flex-1 animate-pulse rounded bg-[var(--surface-sunken)]" />
        <div class="h-4 w-24 animate-pulse rounded bg-[var(--surface-sunken)]" />
        <div class="h-4 w-16 animate-pulse rounded bg-[var(--surface-sunken)]" />
      </div>
    </div>

    <UiEmptyState
      v-else-if="status === 'error'"
      variant="error"
      title="No se han podido cargar los datos"
      :description="errorMessage"
    >
      <UButton icon="i-lucide-rotate-cw" @click="emit('retry')">Reintentar</UButton>
    </UiEmptyState>

    <UiEmptyState
      v-else-if="!rows.length"
      :variant="search ? 'filtered' : 'empty'"
      :title="search ? `Sin resultados para «${search}»` : emptyTitle"
      :description="search ? 'Prueba con otro término o revisa los filtros activos.' : emptyDescription"
    >
      <UButton v-if="search" color="neutral" variant="outline" @click="search = ''">Borrar búsqueda</UButton>
      <slot v-else name="empty-action" />
    </UiEmptyState>

    <template v-else>
      <!-- Escritorio: tabla real -->
      <div class="relative hidden overflow-x-auto md:block">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[var(--border)] text-left">
              <th v-if="selectable" scope="col" class="w-10 px-4 py-3">
                <UCheckbox
                  :model-value="allSelected"
                  aria-label="Seleccionar todas las filas"
                  @update:model-value="toggleAll"
                />
              </th>
              <th
                v-for="column in columns"
                :key="column.key"
                scope="col"
                :data-numeric="column.numeric ? '' : undefined"
                class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
                :class="column.numeric && 'text-right'"
                :aria-sort="sortKey === column.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined"
              >
                <button
                  v-if="column.sortable"
                  type="button"
                  class="inline-flex items-center gap-1 hover:text-[var(--text-strong)]"
                  @click="toggleSort(column)"
                >
                  {{ column.label }}
                  <UIcon
                    :name="
                      sortKey === column.key
                        ? sortDir === 'asc'
                          ? 'i-lucide-arrow-up'
                          : 'i-lucide-arrow-down'
                        : 'i-lucide-chevrons-up-down'
                    "
                    class="size-3.5 opacity-60"
                  />
                </button>
                <template v-else>{{ column.label }}</template>
              </th>
              <th v-if="$slots['row-actions']" scope="col" class="w-px px-4 py-3">
                <span class="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--border)]">
            <tr
              v-for="row in rows"
              :key="rowKey(row)"
              class="transition-colors hover:bg-[var(--canvas)]"
              :class="selected.includes(rowKey(row)) && 'bg-neteco-50'"
            >
              <td v-if="selectable" class="px-4 py-3">
                <UCheckbox
                  :model-value="selected.includes(rowKey(row))"
                  :aria-label="`Seleccionar fila ${rowKey(row)}`"
                  @update:model-value="toggleRow(rowKey(row))"
                />
              </td>
              <td
                v-for="column in columns"
                :key="column.key"
                :data-numeric="column.numeric ? '' : undefined"
                class="px-4 py-3 align-middle"
                :class="column.numeric && 'text-right'"
              >
                <slot :name="`cell-${column.key}`" :row="row" :value="cellValue(row, column)">
                  {{ cellValue(row, column) }}
                </slot>
              </td>
              <td v-if="$slots['row-actions']" class="px-4 py-3 text-right whitespace-nowrap">
                <slot name="row-actions" :row="row" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Móvil: la fila se convierte en tarjeta. Una tabla de 8 columnas a 390 px
           provoca scroll lateral del documento, que es justo lo que pasaba antes. -->
      <ul class="divide-y divide-[var(--border)] md:hidden">
        <li v-for="row in rows" :key="rowKey(row)" class="px-4 py-4">
          <slot name="mobile-row" :row="row">
            <dl class="space-y-1.5">
              <div
                v-for="column in columns.filter((c) => !c.hideOnMobile)"
                :key="column.key"
                class="flex items-baseline justify-between gap-4"
              >
                <dt class="shrink-0 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  {{ column.label }}
                </dt>
                <dd class="min-w-0 text-right" :class="column.numeric && 'tabular font-semibold'">
                  <slot :name="`cell-${column.key}`" :row="row" :value="cellValue(row, column)">
                    {{ cellValue(row, column) }}
                  </slot>
                </dd>
              </div>
            </dl>
            <div v-if="$slots['row-actions']" class="mt-3 flex justify-end">
              <slot name="row-actions" :row="row" />
            </div>
          </slot>
        </li>
      </ul>

      <div
        v-if="pageCount > 1 || totalRows > 0"
        class="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3"
      >
        <p class="tabular text-sm text-[var(--text-muted)]">{{ rangeFrom }}–{{ rangeTo }} de {{ totalRows }}</p>
        <div v-if="pageCount > 1" class="flex items-center gap-1">
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-chevron-left"
            :disabled="page <= 1"
            aria-label="Página anterior"
            @click="emit('update:page', page - 1)"
          />
          <span class="tabular px-2 text-sm text-[var(--text-muted)]">{{ page }} / {{ pageCount }}</span>
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-chevron-right"
            :disabled="page >= pageCount"
            aria-label="Página siguiente"
            @click="emit('update:page', page + 1)"
          />
        </div>
      </div>
    </template>
  </div>
</template>
