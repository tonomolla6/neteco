<script setup lang="ts">
import { ArrowLeft, FileText } from 'lucide-vue-next'

useHead({
  title: 'Aviso Legal - NETECO'
})
</script>

<template>
  <div class="container mx-auto px-6 py-20 lg:py-32 max-w-4xl min-h-screen">
    <NuxtLink
      to="/"
      class="inline-flex items-center gap-2 text-sky-600 hover:text-sky-700 font-bold mb-8 transition group"
    >
      <ArrowLeft class="w-5 h-5 group-hover:-translate-x-1 transition" />
      Volver al inicio
    </NuxtLink>

    <div class="bg-white p-8 md:p-12 rounded-3xl shadow-xl border border-slate-100">
      <div class="flex items-center gap-4 mb-8 pb-8 border-b border-slate-200">
        <div class="p-4 bg-sky-100 rounded-2xl">
          <FileText class="w-8 h-8 text-sky-600" />
        </div>
        <h1 class="text-3xl md:text-4xl font-bold text-slate-900">Aviso Legal</h1>
      </div>

      <div class="prose prose-lg prose-slate max-w-none prose-headings:text-slate-900 prose-headings:font-bold prose-h3:text-xl prose-h3:mt-8 prose-h3:mb-4 prose-p:text-slate-600 prose-p:leading-relaxed prose-li:text-slate-600 prose-strong:text-slate-800">
        <h3>1. Datos Identificativos</h3>
        <p>
          En cumplimiento con el deber de información recogido en artículo 10 de la Ley 34/2002, de 11 de julio, de
          Servicios de la Sociedad de la Información y del Comercio Electrónico, a continuación se reflejan los
          siguientes datos:
        </p>
        <ul>
          <li><strong>Titular:</strong> Maria Carmen González Nacher (en adelante, NETECO)</li>
          <li><strong>N.I.F.:</strong> 52716085Q</li>
          <li><strong>Domicilio:</strong> Ontinyent, Valencia</li>
          <li><strong>Correo electrónico:</strong> administracion@neteco.es</li>
        </ul>

        <h3>2. Usuarios</h3>
        <p>
          El acceso y/o uso de este portal de NETECO atribuye la condición de USUARIO, que acepta, desde dicho acceso
          y/o uso, las Condiciones Generales de Uso aquí reflejadas.
        </p>

        <h3>3. Uso del portal</h3>
        <p>
          Esta página web proporciona acceso a multitud de informaciones, servicios o datos (en adelante, "los
          contenidos") en Internet pertenecientes a NETECO. El USUARIO asume la responsabilidad del uso del portal.
        </p>

        <h3>4. Protección de Datos</h3>
        <p>
          NETECO cumple con las directrices de la normativa vigente en materia de protección de datos personales, y
          vela por garantizar un correcto uso y tratamiento de los datos personales del usuario.
        </p>

        <h3>5. Propiedad Intelectual e Industrial</h3>
        <p>
          NETECO por sí o como cesionaria, es titular de todos los derechos de propiedad intelectual e industrial de
          su página web, así como de los elementos contenidos en la misma (a título enunciativo, imágenes, sonido,
          audio, vídeo, software o textos; marcas o logotipos, combinaciones de colores, estructura y diseño,
          selección de materiales usados, etc.).
        </p>
      </div>
    </div>
  </div>
</template>
