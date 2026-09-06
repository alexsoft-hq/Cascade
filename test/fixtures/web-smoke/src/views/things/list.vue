<template>
  <div class="thing-list">
    <div class="filter">
      <input v-model="q" placeholder="search" />
      <button @click="getList">go</button>
      <button @click="openOrder(1)">order</button>
    </div>
    <table>
      <thead>
        <tr>
          <th>id</th>
          <th>name</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ row.id }}</td>
          <td>{{ row.name }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script>
import { listThings } from '@/api/things'
import { getOrder } from '@/api/orders'

export default {
  name: 'ThingList',
  data() {
    return { q: '', rows: [] }
  },
  methods: {
    getList() {
      listThings(this.q).then((r) => {
        this.rows = r
      })
    },
    openOrder(id) {
      return getOrder(id)
    }
  }
}
</script>
