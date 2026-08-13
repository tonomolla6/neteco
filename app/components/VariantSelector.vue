<script setup lang="ts" generic="T extends { id: string | number; format: string; sku: string }">
defineProps<{ variants: T[]; modelValue: string | number; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()
</script>

<template>
  <fieldset>
    <legend class="mb-2 text-sm font-semibold text-slate-700">
      {{ label ?? 'Formato' }} <span class="font-normal text-slate-500">({{ variants.length }} disponibles)</span>
    </legend>
    <div class="space-y-2">
      <button
        v-for="variant in variants"
        :key="variant.id"
        type="button"
        :aria-pressed="modelValue === variant.id"
        class="flex w-full items-center justify-between rounded-xl border-2 bg-white px-4 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500 focus-visible:ring-offset-2"
        :class="
          modelValue === variant.id
            ? 'border-neteco-500 ring-1 ring-neteco-500'
            : 'border-slate-200 hover:border-neteco-300'
        "
        @click="emit('update:modelValue', variant.id)"
        @keydown.enter.prevent="emit('update:modelValue', variant.id)"
        @keydown.space.prevent="emit('update:modelValue', variant.id)"
      >
        <slot :variant="variant" :selected="modelValue === variant.id">
          <span>{{ variant.format }} · Ref. {{ variant.sku }}</span>
        </slot>
      </button>
    </div>
  </fieldset>
</template>
