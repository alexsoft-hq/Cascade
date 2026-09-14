// A router a setter fills at start-up: no factory call is bound to the name,
// and the type it is declared with is what says it holds a router.
import type { Router } from 'vue-router';

export let router: Router = null as unknown as Router;

export function setRouter(r: Router) {
  router = r;
}
