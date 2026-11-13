<script setup lang="ts">
/**
 * Gráfica de barras de una sola serie (evolución por día, semana…). SVG propio: un único
 * color de marca, rejilla discreta, etiquetas de eje espaciadas y detalle al pasar el cursor
 * o al enfocar con teclado. Los valores siempre se pueden leer también en texto (`summary`).
 */
const props = withDefaults(
  defineProps<{
    points: Array<{ label: string; value: number; detail?: string }>
    format?: (value: number) => string
    height?: number
    /** Descripción accesible de lo que muestra la gráfica. */
    summary: string
  }>(),
  { format: (value: number) => value.toLocaleString('es-ES'), height: 220 }
)
const WIDTH = 720
const PAD = { top: 12, right: 8, bottom: 26, left: 8 }
const active = ref<number | null>(null)
function niceMax(value: number) {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  return [1, 2, 2.5, 5, 10].map((step) => step * power).find((step) => step >= value) ?? value
}
const max = computed(() => niceMax(Math.max(0, ...props.points.map((point) => point.value))))
const innerHeight = computed(() => props.height - PAD.top - PAD.bottom)
const slot = computed(() => (WIDTH - PAD.left - PAD.right) / Math.max(1, props.points.length))
const bars = computed(() =>
  props.points.map((point, index) => {
    const width = Math.min(28, Math.max(2, slot.value - 2))
    const height = point.value > 0 ? Math.max(2, (point.value / max.value) * innerHeight.value) : 0
    const x = PAD.left + slot.value * index + (slot.value - width) / 2
    const y = PAD.top + innerHeight.value - height
    const radius = Math.min(4, width / 2, height)
    return {
      ...point,
      index,
      centre: x + width / 2,
      // Extremo superior redondeado, base recta apoyada en el eje.
      path: height
        ? `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}Z`
        : ''
    }
  })
)
const grid = computed(() =>
  [0, 0.5, 1].map((share) => ({ y: PAD.top + innerHeight.value * (1 - share), value: max.value * share }))
)
const every = computed(() => Math.max(1, Math.ceil(props.points.length / 8)))
const empty = computed(() => props.points.every((point) => point.value === 0))
</script>

<template>
  <figure class="adm-chart" :style="{ '--adm-chart-height': `${height}px` }">
    <figcaption class="sr-only">{{ summary }}</figcaption>
    <div class="adm-chart__plot" @mouseleave="active = null">
      <svg :viewBox="`0 0 ${WIDTH} ${height}`" preserveAspectRatio="none" aria-hidden="true">
        <g v-for="line in grid" :key="line.y">
          <line :x1="PAD.left" :x2="WIDTH - PAD.right" :y1="line.y" :y2="line.y" class="adm-chart__grid" />
        </g>
        <path
          v-for="bar in bars"
          :key="bar.index"
          :d="bar.path"
          class="adm-chart__bar"
          :data-active="active === bar.index || undefined"
        />
      </svg>
      <div class="adm-chart__hits">
        <button
          v-for="bar in bars"
          :key="bar.index"
          type="button"
          :aria-label="`${bar.detail ?? bar.label}: ${format(bar.value)}`"
          @mouseenter="active = bar.index"
          @focus="active = bar.index"
          @blur="active = null"
        />
      </div>
      <span class="adm-chart__max">{{ format(max) }}</span>
      <p v-if="empty" class="adm-chart__empty">Sin datos en este periodo</p>
      <div
        v-if="active !== null && bars[active]"
        class="adm-chart__tip"
        :style="{ left: `${(bars[active]!.centre / WIDTH) * 100}%` }"
        role="status"
      >
        <strong>{{ format(bars[active]!.value) }}</strong>
        <span>{{ bars[active]!.detail ?? bars[active]!.label }}</span>
      </div>
    </div>
    <ol class="adm-chart__axis" aria-hidden="true">
      <li v-for="bar in bars" :key="bar.index">
        <span v-if="bar.index % every === 0">{{ bar.label }}</span>
      </li>
    </ol>
  </figure>
</template>
