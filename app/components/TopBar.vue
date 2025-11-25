<script setup lang="ts">
import { Phone, Clock } from 'lucide-vue-next'
</script>

<template>
  <div class="bg-slate-900 text-slate-300 py-2 text-sm">
    <div class="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-2">
      <div class="flex items-center gap-4 md:gap-8">
        <a href="tel:600861334" class="flex items-center gap-2 hover:text-white transition">
          <Phone class="w-4 h-4" /> 600 861 334
        </a>
        <a href="tel:637442546" class="flex items-center gap-2 hover:text-white transition">
          <Phone class="w-4 h-4" /> 637 442 546
        </a>
      </div>
      <div class="flex items-center gap-2 text-xs md:text-sm font-medium text-sky-400">
        <Clock class="w-3 h-3" />
        <span>Atención a empresas y profesionales</span>
      </div>
    </div>
  </div>
</template>
