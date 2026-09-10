<template>
  <div />
</template>
<script>
// Vue: `$router` is the router the framework itself puts on every component.
export default {
  methods: {
    openCrate(crateNo) {
      this.$router.push({ path: '/crates/' + crateNo })
    },
    backToList() {
      this.$router.replace('/crates')
    },
  },
}
</script>
