import { p3, p4, p5, p6 } from './hops';
export const b3 = () => p3({ url: '/items', alt: 1 });
export const b4 = () => p4({ url: '/items' }, '/v2');
export const b5 = () => p5({ url: '/items' });
export const b6 = () => p6({ url: '/items' });
