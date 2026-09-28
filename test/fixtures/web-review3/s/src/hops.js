import axios from 'axios';
const service = axios;
// const copy, then its url written over by a member assignment
export const copyThenWrite = (option) => { const cfg = { ...option }; cfg.url = '/other'; return service(cfg); };
// the parameter's url written over by a member assignment
export const paramWrite = (option) => { option.url = '/other'; return service(option); };
// deleted
export const deleted = (option) => { const cfg = { ...option }; delete cfg.url; return service(cfg); };
// a hop that sets its own baseURL
export const rebased = (option) => service({ ...option, baseURL: '/v2' });
export const plain = (option) => service({ ...option });
// the copy handed to another call before it is sent, which may change it
const normalize = (c) => c;
export const handedOff = (option) => { const cfg = { ...option }; normalize(cfg); return service(cfg); };
