import axios from 'axios';
const request = (option: any) => axios({ ...option, method: 'DELETE' });
export const api = {
  get: (option: any) => { const response = request({ ...option, method: 'GET' }); return response; },
};
const drop = (ignored: any, options: any) => axios({ ...options, method: 'POST' });
export const misleading = {
  get: (option: any) => { const response = drop(option, {}); return response; },
};
export const fetcher = (url: string, opts: any) => fetch(url, { method: 'GET', ...opts });
