<script setup lang="ts">
import { Utensils, ShoppingBag, Factory, Building2 } from 'lucide-vue-next'

const sectores = [
  {
    icon: Utensils,
    title: 'Hostelería',
    desc: 'Restaurantes, bares y cafeterías. Higiene de cocina y menaje.'
  },
  {
    icon: ShoppingBag,
    title: 'Comercio',
    desc: 'Tiendas y locales que cuidan su imagen ante el público.'
  },
  {
    icon: Factory,
    title: 'Industria',
    desc: 'Limpieza técnica y mantenimiento para naves y talleres.'
  },
  {
    icon: Building2,
    title: 'Colectividades',
    desc: 'Colegios, residencias y centros públicos.'
  }
]
</script>

<template>
  <section id="servicios" class="py-20 bg-white border-y border-slate-200">
    <div class="container mx-auto px-6 text-center">
      <h2 class="text-3xl font-bold text-slate-900 mb-4">Suministro Integral</h2>
      <p class="text-slate-500 max-w-2xl mx-auto mb-16">
        Cubrimos todas las necesidades de higiene, embalaje y equipamiento para cualquier tipo de actividad.
      </p>

      <div class="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
        <div
          v-for="(sector, idx) in sectores"
          :key="idx"
          class="bg-slate-50 p-8 rounded-2xl border border-slate-100 hover:border-sky-200 hover:shadow-xl hover:-translate-y-1 transition duration-300"
        >
          <component :is="sector.icon" class="w-12 h-12 text-sky-600 mb-6 mx-auto" />
          <h3 class="text-xl font-bold text-slate-900 mb-3">{{ sector.title }}</h3>
          <p class="text-sm text-slate-500">{{ sector.desc }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
