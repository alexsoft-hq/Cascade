import axios from 'axios';
export function w1(o, verb) { const cfg = { ...o }; cfg.method = verb; return axios(cfg); }
export function w2(o, extra) { const cfg = { ...o }; Object.assign(cfg, extra); return axios(cfg); }
export function w3(o, k) { const cfg = { ...o }; cfg[k] = 'POST'; return axios(cfg); }
export function w4(o) { const cfg = { ...o }; if (o.x) cfg.method = 'POST'; return axios(cfg); }
export function w5(o) { o.method = o.upload ? 'POST' : 'PUT'; return axios(o); }
export function w6(o) { const cfg = { ...o }; mutate(cfg); return axios(cfg); }
function mutate(c) { c.method = 'DELETE'; }
export function w7(o) { const cfg = { ...o }; [1].forEach(() => { cfg.method = 'POST'; }); return axios(cfg); }
export function w8(o) { const c2 = o; c2.method = 'POST'; return axios(o); }
export function w9(o) { Reflect.set(o, 'method', 'PATCH'); return axios(o); }
export function w10(o) { ({ m: o.method } = { m: 'POST' }); return axios(o); }
export function w11(o) { let c = o; c.method = 'POST'; return axios(o); }
export function w12(o) { const cfg = Object.assign({}, o, { method: 'DELETE' }); return axios(cfg); }
export function w13(o) { const cfg = { ...o, ...{ method: 'PUT' } }; return axios(cfg); }
