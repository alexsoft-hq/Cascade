import { req, req2 } from './w';
export const k1 = () => req('/items', 'DELETE');
export const k2 = () => req2({ url: '/items', method: 'PUT' });
export const k3 = () => req2({ url: '/items' });
