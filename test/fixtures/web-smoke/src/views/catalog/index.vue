<template>
  <div class="catalog">
    <ul>
      <li v-for="row in rows" :key="row.id">{{ row.name }}</li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { listCatalog } from '@/api/catalog'

const rows = ref([])

onMounted(async () => {
  rows.value = await listCatalog({ page: 1 })
})
</script>
