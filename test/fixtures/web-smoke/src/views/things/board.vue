<template>
  <div class="thing-board">
    <button @click="reload">reload</button>
  </div>
</template>

<script>
import { listThings, saveThing } from '@/api/things'
import * as thingApi from '@/api/things'
import { usePagedList } from '@/utils/paged'

export default {
  name: 'ThingBoard',
  setup() {
    const board = usePagedList({ api: listThings, title: 'board', after: (rows) => rows.length })
    const submit = usePagedList(saveThing, 'submit')
    const detail = usePagedList(thingApi.detailThing)
    return { board, submit, detail }
  },
  methods: {
    reload() {
      return this.board.reload()
    }
  }
}
</script>
