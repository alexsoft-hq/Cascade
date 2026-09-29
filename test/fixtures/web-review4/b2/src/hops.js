import axios from 'axios';
const service = axios;
export const p3 = (o) => { const cfg = { ...o }; if (o.alt) cfg.baseURL = '/v2'; return service(cfg); };
export const p4 = (o, b) => { const cfg = { ...o }; cfg.baseURL = b; return service(cfg); };
export const p5 = (o) => { const cfg = { ...o }; cfg.baseURL = '/v2'; cfg.baseURL = '/v3'; return service(cfg); };
export const p6 = (o) => { const cfg = { ...o }; cfg.baseURL = '/v2'; return service(cfg); };
