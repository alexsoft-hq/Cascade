import { createRouter, createWebHistory } from 'vue-router'
import Layout from '@/layout/index.vue'

export const constantRoutes = [
  {
    path: '/login',
    component: () => import('@/views/login/index.vue'),
    hidden: true
  },
  {
    path: '/',
    component: Layout,
    redirect: '/things/list',
    children: [
      {
        path: 'things/list',
        name: 'ThingList',
        component: () => import('@/views/things/list.vue'),
        meta: { title: 'Things' }
      }
    ]
  }
]

export const asyncRoutes = [
  {
    path: '/catalog',
    component: Layout,
    meta: { title: 'Catalog' },
    children: [
      {
        path: 'index',
        name: 'CatalogIndex',
        component: () => import('@/views/catalog/index.vue'),
        meta: { title: 'Catalog index' }
      }
    ]
  }
]

export default createRouter({
  history: createWebHistory(),
  routes: constantRoutes
})
