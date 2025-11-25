<script setup lang="ts">
import { Truck, HeartHandshake, ShieldCheck } from 'lucide-vue-next'

const cards = [
  {
    icon: Truck,
    title: 'Logística Propia',
    description: 'No dependemos de agencias externas para la zona. Repartimos nosotros mismos en Ontinyent y alrededores para asegurar que te llegue bien.',
    color: 'blue'
  },
  {
    icon: HeartHandshake,
    title: 'Trato de Tú a Tú',
    description: 'Sin centralitas automáticas ni robots. Hablas con personas que conocen tu negocio y saben lo que necesitas.',
    color: 'green'
  },
  {
    icon: ShieldCheck,
    title: 'Garantía Profesional',
    description: 'Trabajamos con marcas líderes como NETTION. Productos concentrados y de alto rendimiento que no encuentras en el súper.',
    color: 'purple'
  }
]

const getColorClasses = (color: string) => {
  const colors: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-600',
    green: 'bg-green-100 text-green-600',
    purple: 'bg-purple-100 text-purple-600'
  }
  return colors[color] || colors.blue
}
</script>

<template>
  <section class="py-16 bg-white">
    <div class="container mx-auto px-6">
      <div class="grid md:grid-cols-3 gap-8">
        <div
          v-for="(card, idx) in cards"
          :key="idx"
          class="p-6 rounded-2xl bg-slate-50 border border-slate-100 hover:shadow-lg transition duration-300"
        >
          <div
            class="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
            :class="getColorClasses(card.color)"
          >
            <component :is="card.icon" class="w-6 h-6" />
          </div>
          <h3 class="text-lg font-bold text-slate-900 mb-2">{{ card.title }}</h3>
          <p class="text-slate-500 text-sm">{{ card.description }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
