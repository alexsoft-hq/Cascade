import axios from 'axios';

// SETTLED: the syntax says whether the caller's `url` is in what goes on.
// Takes two keys out and hands the rest on: `url` is in the rest.
export const request = (option: any) => {
  const { headersType, headers, ...otherOption } = option;
  return axios({ ...otherOption, headers: { 'Content-Type': headersType, ...headers } });
};
// Takes `url` out and hands only the rest on: the URL is dropped.
export const dropsUrl = (option: any) => { const { url, ...rest } = option; return axios({ ...rest }); };
// Takes `url` out and puts it back under its own key.
export const keepsUrl = (option: any) => { const { url, ...rest } = option; return axios({ ...rest, url }); };
// The same two, written in the signature.
export const signatureDrops = ({ url, ...rest }: any) => axios({ ...rest });
export const signatureKeeps = ({ headers, ...rest }: any) => axios({ ...rest, headers });
// The parameter under another name, and a copy with a key written over.
export const alias = (option: any) => { const o = option; return axios(o); };
export const copy = (option: any) => { const cfg = { ...option, timeout: 1 }; return axios(cfg); };
// One key of it, as the value of the client's own key.
export const byKey = (option: any) => axios({ url: option.url, method: 'GET' });
// A copy that writes `url` over: the caller's is gone.
export const overwrites = (option: any) => { const cfg = { ...option, url: '/other' }; return axios(cfg); };
// Takes `url` out and reads another key it took out: that key does not carry the URL.
export const dropsWithHeaders = (option: any) => {
  const { url, headers, ...rest } = option;
  return axios({ ...rest, headers: { ...headers, 'X-Id': 1 } });
};

// NOT SETTLED: nothing written says whether the URL goes on.
export const reassigned = (config: any) => { let conf = config; conf = { ...conf, timeout: 1 }; return axios(conf); };
export const writtenOver = (option: any) => { option = { ...option, timeout: 1 }; return axios(option); };
export const throughThis = function (option: any) { this.last = option; return axios(this.last); };
export const throughCall = (option: any) => axios(Object.assign({}, option));
// The URL taken out and put back through a call on it.
const withBase = (u: string) => u.trim();
export const prefixes = (option: any) => { const { url, ...rest } = option; return axios({ ...rest, url: withBase(url) }); };
// A step read only as the call it returns: what it passes on was not recorded.
const send = (cfg: any) => axios(cfg);
export const throughReturn = (option: any) => send(Object.assign({}, option));
