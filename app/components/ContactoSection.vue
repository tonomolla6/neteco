<script setup lang="ts">
import { Phone, Mail, MapPin } from 'lucide-vue-next'
</script>

<template>
  <section id="contacto" class="py-20 bg-white">
    <div class="container mx-auto px-6">
      <div class="max-w-5xl mx-auto bg-slate-900 rounded-3xl overflow-hidden shadow-2xl flex flex-col md:flex-row">
        <div class="p-10 md:w-3/5 text-white flex flex-col justify-center">
          <h2 class="text-3xl font-bold mb-6">Contacta con nosotros</h2>
          <p class="text-slate-300 mb-8">
            Estamos en Ontinyent para ayudar a tu empresa. Llámanos o escríbenos para solicitar presupuesto.
          </p>

          <div class="space-y-6">
            <div class="flex items-start gap-4">
              <div class="bg-sky-600/20 p-3 rounded-xl">
                <Phone class="w-6 h-6 text-sky-400" />
              </div>
              <div>
                <p class="text-xs text-slate-400 uppercase font-bold tracking-wider">Teléfonos</p>
                <a href="tel:600861334" class="text-lg font-bold hover:text-sky-400 transition block">600 861 334</a>
                <a href="tel:637442546" class="text-lg font-bold hover:text-sky-400 transition block">637 442 546</a>
              </div>
            </div>

            <div class="flex items-start gap-4">
              <div class="bg-sky-600/20 p-3 rounded-xl">
                <Mail class="w-6 h-6 text-sky-400" />
              </div>
              <div>
                <p class="text-xs text-slate-400 uppercase font-bold tracking-wider">Email Administración</p>
                <a href="mailto:administracion@neteco.es" class="text-lg hover:text-sky-400 transition break-all">
                  administracion@neteco.es
                </a>
              </div>
            </div>

            <div class="flex items-start gap-4">
              <div class="bg-sky-600/20 p-3 rounded-xl">
                <MapPin class="w-6 h-6 text-sky-400" />
              </div>
              <div>
                <p class="text-xs text-slate-400 uppercase font-bold tracking-wider">Ubicación</p>
                <p class="text-lg">Ontinyent, Valencia</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Mapa o Imagen Decorativa -->
        <div class="md:w-2/5 bg-slate-800 relative min-h-[300px]">
          <img
            src="https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&q=80"
            alt="Edificio corporativo"
            class="absolute inset-0 w-full h-full object-cover opacity-40 mix-blend-overlay"
          />
          <div class="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
            <div class="w-16 h-16 bg-white/10 backdrop-blur-sm rounded-full flex items-center justify-center mb-4">
              <MapPin class="w-8 h-8 text-sky-400" />
            </div>
            <div class="text-white font-medium">Estamos cerca de ti</div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
