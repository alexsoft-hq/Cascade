// A component helper reaching the router through a named import and a re-export.
import { router } from '@/router/entry';
import { extraRoutes } from '@/router/entry';

export function openRows() {
  router.push('/rows');
}

export function addRoute() {
  // An array exported beside the router is not a router.
  extraRoutes.push({ path: '/extra' });
}
