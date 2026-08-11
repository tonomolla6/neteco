<script setup lang="ts">
// Ilustraciones SVG de producto para la demo: se sustituirán por fotos reales al importar el catálogo.
const props = defineProps<{ visual?: { type: string; color: string } | null }>()

const type = computed(() => props.visual?.type ?? 'garrafa')
const color = computed(() => props.visual?.color ?? '#009ac9')
</script>

<template>
  <svg viewBox="0 0 120 120" class="block w-full h-auto select-none" role="img" aria-hidden="true">
    <rect x="0" y="0" width="120" height="120" rx="16" :fill="color + '12'" />
    <g stroke="#cbd5e1" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">
      <template v-if="type === 'garrafa'">
        <path d="M42 38 V31 a8 8 0 0 1 8-8 h8" fill="none" stroke="#94a3b8" stroke-width="5" />
        <rect x="66" y="24" width="16" height="13" rx="3" :fill="color" stroke="none" />
        <rect x="32" y="37" width="56" height="67" rx="9" fill="#fff" />
        <rect x="40" y="56" width="40" height="30" rx="4" :fill="color" opacity="0.14" stroke="none" />
        <rect x="40" y="56" width="40" height="9" rx="3" :fill="color" stroke="none" />
      </template>

      <template v-else-if="type === 'botella'">
        <rect x="50" y="17" width="20" height="11" rx="3" :fill="color" stroke="none" />
        <path d="M53 28 h14 v6 c6 4 9 8 9 14 v46 a10 10 0 0 1 -10 10 h-12 a10 10 0 0 1 -10 -10 V48 c0-6 3-10 9-14 z" fill="#fff" />
        <rect x="50" y="56" width="20" height="28" rx="3" :fill="color" opacity="0.14" stroke="none" />
        <rect x="50" y="56" width="20" height="8" rx="3" :fill="color" stroke="none" />
      </template>

      <template v-else-if="type === 'spray'">
        <rect x="42" y="18" width="26" height="13" rx="4" :fill="color" stroke="none" />
        <rect x="34" y="21" width="10" height="7" rx="2" :fill="color" stroke="none" />
        <path d="M46 31 l-7 14 h7 z" :fill="color" stroke="none" />
        <rect x="53" y="31" width="10" height="15" fill="#fff" />
        <rect x="41" y="46" width="36" height="58" rx="9" fill="#fff" />
        <rect x="48" y="62" width="22" height="26" rx="3" :fill="color" opacity="0.14" stroke="none" />
        <rect x="48" y="62" width="22" height="8" rx="3" :fill="color" stroke="none" />
      </template>

      <template v-else-if="type === 'caja'">
        <rect x="28" y="40" width="64" height="60" rx="5" fill="#fff" />
        <rect x="28" y="52" width="64" height="9" :fill="color" opacity="0.28" stroke="none" />
        <path d="M28 46 L60 40 L92 46" fill="none" stroke="#94a3b8" />
        <rect x="38" y="66" width="30" height="22" rx="3" :fill="color" opacity="0.14" stroke="none" />
        <rect x="38" y="66" width="30" height="7" rx="3" :fill="color" stroke="none" />
        <circle cx="81" cy="88" r="6" :fill="color" stroke="none" />
      </template>

      <template v-else-if="type === 'saco'">
        <rect x="32" y="34" width="56" height="70" rx="12" fill="#fff" />
        <path d="M38 34 h44" stroke="#94a3b8" stroke-dasharray="4 4" />
        <rect x="32" y="60" width="56" height="14" :fill="color" opacity="0.85" stroke="none" />
        <rect x="32" y="78" width="56" height="5" :fill="color" opacity="0.25" stroke="none" />
      </template>

      <template v-else-if="type === 'capsulas'">
        <path d="M36 42 h48 a6 6 0 0 1 6 6 v48 a8 8 0 0 1 -8 8 h-44 a8 8 0 0 1 -8 -8 V48 a6 6 0 0 1 6 -6 z" fill="#fff" />
        <rect x="30" y="32" width="60" height="10" rx="3" :fill="color" opacity="0.3" stroke="none" />
        <circle cx="49" cy="80" r="9" :fill="color" stroke="none" />
        <circle cx="66" cy="70" r="9" :fill="color" opacity="0.7" stroke="none" />
        <circle cx="73" cy="88" r="9" :fill="color" opacity="0.45" stroke="none" />
      </template>

      <template v-else-if="type === 'difusor'">
        <path d="M44 46 v-4 a16 16 0 0 1 32 0 v4 z" :fill="color" opacity="0.85" stroke="none" />
        <rect x="40" y="46" width="40" height="58" rx="9" fill="#fff" />
        <rect x="48" y="62" width="24" height="4" rx="2" :fill="color" opacity="0.4" stroke="none" />
        <rect x="48" y="70" width="24" height="4" rx="2" :fill="color" opacity="0.25" stroke="none" />
        <circle cx="88" cy="30" r="3" :fill="color" opacity="0.6" stroke="none" />
        <circle cx="96" cy="22" r="2.5" :fill="color" opacity="0.4" stroke="none" />
        <circle cx="90" cy="14" r="2" :fill="color" opacity="0.25" stroke="none" />
      </template>

      <template v-else-if="type === 'cubo'">
        <path d="M40 42 c0-18 40-18 40 0" fill="none" stroke="#94a3b8" stroke-width="4" />
        <rect x="31" y="40" width="58" height="9" rx="3" :fill="color" stroke="none" />
        <path d="M35 49 h50 l-5 50 a7 7 0 0 1 -7 6 h-26 a7 7 0 0 1 -7 -6 z" fill="#fff" />
        <path d="M42 60 h36 M44 72 h32" :stroke="color" stroke-opacity="0.3" />
      </template>

      <template v-else-if="type === 'rollo'">
        <circle cx="58" cy="64" r="36" fill="#fff" />
        <circle cx="58" cy="64" r="14" fill="#f1f5f9" />
        <circle cx="58" cy="64" r="7" :fill="color" opacity="0.35" stroke="none" />
        <path d="M58 100 h40" stroke="#cbd5e1" />
        <path d="M94 100 v-8" stroke="#cbd5e1" />
      </template>

      <template v-else-if="type === 'vaso'">
        <rect x="37" y="26" width="46" height="7" rx="3" :fill="color" stroke="none" />
        <path d="M41 33 h38 l-6 66 a6 6 0 0 1 -6 5 h-14 a6 6 0 0 1 -6 -5 z" fill="#fff" />
        <path d="M44 56 h32" :stroke="color" stroke-opacity="0.45" stroke-width="6" />
      </template>

      <template v-else-if="type === 'guante'">
        <rect x="43" y="30" width="10" height="30" rx="5" fill="#fff" />
        <rect x="55" y="25" width="10" height="35" rx="5" fill="#fff" />
        <rect x="67" y="29" width="10" height="31" rx="5" fill="#fff" />
        <rect x="74" y="50" width="24" height="11" rx="5.5" transform="rotate(-35 74 50)" fill="#fff" />
        <rect x="41" y="48" width="38" height="38" rx="9" fill="#fff" />
        <rect x="47" y="62" width="26" height="9" rx="3" :fill="color" opacity="0.18" stroke="none" />
        <rect x="39" y="86" width="42" height="13" rx="4" :fill="color" stroke="none" />
      </template>

      <template v-else>
        <rect x="34" y="30" width="52" height="74" rx="9" fill="#fff" />
        <rect x="42" y="52" width="36" height="28" rx="4" :fill="color" opacity="0.2" stroke="none" />
      </template>
    </g>
  </svg>
</template>
