import axios from 'axios';
// T1: hop0 keeps only url; hop1 default overridable
const req1 = (x) => axios({ method: 'GET', ...x });
export const pick = (o) => req1({ url: o.url });
// T2: fetch wrapper drops options
export const fetcher2 = (u, o) => fetch(u);
// T3: method as a variable
const req3 = (verb, o) => axios({ ...o, method: verb });
export const api3 = { del: (o) => req3('DELETE', o) };
// T4: branches
export function branchy(o) {
  if (o.upload) return axios({ ...o, method: 'POST' });
  return axios({ ...o, method: 'GET' });
}
// T5: url written over on the options
export function prefixed(o) {
  o.url = '/api' + o.url;
  return axios(o);
}
// T8: method set on a const copy
export function posting(o) {
  const cfg = { ...o };
  cfg.method = 'POST';
  return axios(cfg);
}
// T9: Object.assign onto the param
export function assigned(o) {
  Object.assign(o, { method: 'DELETE' });
  return axios(o);
}
