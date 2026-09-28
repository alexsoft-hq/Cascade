import { client } from './guards';
export const throughMember = () => client.member({ url: '/items' });
export const throughLocal = () => client.local({ url: '/items' });
export const throughRest = () => client.rest({ url: '/items' });
export const callerMethod = () => client.post({ url: '/items', method: 'POST' });
