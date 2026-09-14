<template>
  <div>
    <router-link to="/rows">the rows</router-link>
    <RouterLink to="/panel">this panel</RouterLink>
    <router-link :to="{ path: computedPath }">computed</router-link>
    <a href="/not/a/router/link">an ordinary link</a>
  </div>
</template>

<script>
import router from '@/router';
import legacy from '@/router/legacy';
import rows from '@/lib/rows';

export default {
  methods: {
    openRows() {
      router.push('/rows');
    },
    openLegacy() {
      legacy.replace('/panel');
    },
    openByName() {
      router.push({ name: 'rows' });
    },
    notARouter() {
      rows.push('/rows');
    },
    leave() {
      location.href = '/rows';
    },
  },
};
</script>
