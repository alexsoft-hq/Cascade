import axios from 'axios';
const service = axios;
const other = {};
const keep = [];
// Each of these puts the object somewhere, or writes it, in a shape no list names.
export const e1 = (option) => { const cfg = { ...option }; const box = { cfg }; box.cfg.url = '/other'; return service(cfg); };
export const e2 = (option) => { const cfg = { ...option }; const pair = [cfg]; pair[0].url = '/other'; return service(cfg); };
export const e3 = (option) => { const cfg = { ...option }; other.cfg = cfg; other.cfg.url = '/other'; return service(cfg); };
export const e4 = (option) => { const cfg = { ...option }; ({ url: cfg.url } = { url: '/other' }); return service(cfg); };
export const e5 = (option) => { const cfg = { ...option }; for (cfg.url of ['/other']) keep.push(1); return service(cfg); };
export const e6 = (option) => { const cfg = { ...option }; [cfg.url] = ['/other']; return service(cfg); };
export const e7 = (option) => { const cfg = { ...option, move() { this.url = '/other'; } }; cfg.move(); return service(cfg); };
export const e8 = (option, flag) => { const cfg = { ...option }; const c = flag ? cfg : other; c.url = '/other'; return service(cfg); };
export const e9 = (option) => { const cfg = { ...option }; const c = cfg || other; c.url = '/other'; return service(cfg); };
export const e10 = (option) => { const cfg = { ...option }; keep.push(cfg); keep[0].url = '/other'; return service(cfg); };
const tag = (s, c) => { c.url = '/other'; return s; };
export const e11 = (option) => { const cfg = { ...option }; tag`${cfg}`; return service(cfg); };
// Each of these only reads it: nothing here changes what is sent.
export const r1 = (option) => { const cfg = { ...option }; if (!cfg.url) throw new Error('no url'); console.info(cfg.url); return service(cfg); };
export const r2 = (option) => { const cfg = { ...option }; const n = Object.keys(cfg).length; keep.push(n); return service(cfg); };
export const r3 = (option) => { const cfg = { ...option }; const copy = { ...cfg }; keep.push(copy); const { url } = cfg; keep.push(url); return service(cfg); };
