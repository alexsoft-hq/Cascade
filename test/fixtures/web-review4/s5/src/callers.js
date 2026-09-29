import { api } from './http';
export function g1() { const cfg = { url: '/items' }; return api.post(cfg); }
export function g2() { let cfg = { url: '/items' }; return api.post(cfg); }
export function g3() { const cfg = { url: '/items' }; return api.get(cfg); }
export function g4() { return api.post({ url: '/items' }); }
