import { pick, fetcher2, api3, branchy, prefixed, posting, assigned } from './wrappers';
export const t1 = () => pick({ url: '/items', method: 'DELETE' });
export const t2 = () => fetcher2('/items', { method: 'POST' });
export const t3 = () => api3.del({ url: '/items' });
export const t4 = () => branchy({ url: '/items', upload: true });
export const t4b = () => branchy({ url: '/items' });
export const t5 = () => prefixed({ url: '/items' });
export const t8 = () => posting({ url: '/items' });
export const t9 = () => assigned({ url: '/items' });
