import { copyThenWrite, paramWrite, deleted, rebased, plain, handedOff } from './hops';
export const a = () => copyThenWrite({ url: '/items' });
export const b = () => paramWrite({ url: '/items' });
export const c = () => deleted({ url: '/items' });
export const d = () => rebased({ url: '/items' });
export const e = () => plain({ url: '/items', baseURL: '/v2' });
export const f = () => handedOff({ url: '/items' });
