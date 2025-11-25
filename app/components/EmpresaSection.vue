<script setup lang="ts">
import { CheckCircle2 } from 'lucide-vue-next'

const features = [
  'Atención exclusiva a profesionales y empresas.',
  'Stock permanente en almacén propio.',
  'Asesoramiento técnico personalizado.'
]
</script>

<template>
  <section id="empresa" class="py-20 bg-slate-50">
    <div class="container mx-auto px-6">
      <div class="flex flex-col lg:flex-row items-center gap-16">
        <div class="lg:w-1/2">
          <div class="relative">
            <!-- Imagen conceptual -->
            <img
              src="https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&q=80"
              alt="Almacén Neteco"
              class="rounded-2xl shadow-2xl"
            />
            <div class="absolute -bottom-6 -right-6 bg-sky-600 p-8 rounded-2xl text-white shadow-xl hidden md:block">
              <span class="block text-5xl font-bold mb-1">+25</span>
              <span class="text-sm font-medium uppercase tracking-wider">Años de<br />Experiencia</span>
            </div>
          </div>
        </div>
        <div class="lg:w-1/2">
          <h2 class="text-3xl font-bold text-slate-900 mb-6">Solidez y compromiso local</h2>
          <div class="space-y-6 text-lg text-slate-600">
            <p>
              En <strong>NETECO</strong> llevamos más de 25 años dedicados a facilitar el día a día de empresas y
              profesionales. Entendemos que un negocio no puede pararse por falta de suministros.
            </p>
            <p>
              No somos una tienda online impersonal. Somos tu socio local en Ontinyent. Tratamos de tú a tú, entendemos
              tus necesidades y te proveemos de todo lo necesario para que tú solo te preocupes de vender.
            </p>

            <ul class="pt-4 space-y-3">
              <li v-for="(feature, idx) in features" :key="idx" class="flex items-center gap-3">
                <CheckCircle2 class="w-5 h-5 text-sky-500" />
                <span>{{ feature }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
