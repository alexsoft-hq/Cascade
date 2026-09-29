import axios from 'axios';
import { POST, K } from './consts';
const inst = axios.create({ baseURL: '/api' });
// v1: method from a const in another module
export const v1 = (o) => axios({ ...o, method: POST });
// v2: computed key
export const v2 = (o) => axios({ ...o, [K]: 'POST' });
// v3: m ?? 'GET'
export const v3 = (o, m) => axios({ ...o, method: m ?? 'GET' });
// v4: spread after method (caller's wins)
export const v4 = (o) => axios({ method: 'GET', ...o });
// v5: two sinks in branches, different methods, via ternary
export const v5 = (o) => (o.flag ? axios({ ...o, method: 'PUT' }) : axios({ ...o, method: 'DELETE' }));
// v6: axios.request
export const v6 = (o) => axios.request({ ...o, method: 'PATCH' });
// v7: instance.post(url, data, cfg) with cfg.method
export const v7 = (u, d) => inst.post(u, d, { method: 'PUT' });
// v8: method set conditionally after copy
export function v8(o) { const cfg = { ...o }; if (o.x) cfg.method = 'POST'; return axios(cfg); }
// v9: method via object spread of a local object with method
const defaults = { method: 'PUT' };
export const v9 = (o) => axios({ ...defaults, ...o });
// v10: method in a let reassigned
export function v10(o) { let m = 'GET'; if (o.w) m = 'POST'; return axios({ ...o, method: m }); }
// v11: switch-case two sinks
export function v11(o) { switch (o.k) { case 1: return axios({ ...o, method: 'POST' }); default: return axios.get(o.url); } }
// v12: instance.request with method from caller
export const v12 = (o) => inst.request(o);
// v13: method written lowercase
export const v13 = (o) => axios({ ...o, method: 'post' });
// v14: method assigned twice unconditionally
export function v14(o) { const c = { ...o }; c.method = 'POST'; c.method = 'PUT'; return axios(c); }
// v15: try/catch fallback sink
export async function v15(o) { try { return await axios({ ...o, method: 'POST' }); } catch (e) { return axios({ ...o, method: 'GET' }); } }
