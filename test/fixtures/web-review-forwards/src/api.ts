import { api, misleading, fetcher } from './wrappers';
export const innerOverrides = () => api.get({ url: '/items' });
export const wrongArgument = () => misleading.get({ url: '/items' });
export const fetchOverrides = () => fetcher('/items', { method: 'POST' });
