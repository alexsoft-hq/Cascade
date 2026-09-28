import {
  request, dropsUrl, keepsUrl, signatureDrops, signatureKeeps, alias, copy, byKey, overwrites, dropsWithHeaders,
  reassigned, writtenOver, throughThis, throughCall, prefixes, throughReturn,
} from './hops';

export const viaRest = () => request({ url: '/items', headersType: 'json' });
export const viaDrop = () => dropsUrl({ url: '/items' });
export const viaKeep = () => keepsUrl({ url: '/items' });
export const viaSignatureDrop = () => signatureDrops({ url: '/items' });
export const viaSignatureKeep = () => signatureKeeps({ url: '/items' });
export const viaAlias = () => alias({ url: '/items' });
export const viaCopy = () => copy({ url: '/items' });
export const viaKey = () => byKey({ url: '/items' });
export const viaOverwrite = () => overwrites({ url: '/items' });
export const viaDropWithHeaders = () => dropsWithHeaders({ url: '/items' });

export const viaReassigned = () => reassigned({ url: '/items' });
export const viaWrittenOver = () => writtenOver({ url: '/items' });
export const viaThis = () => throughThis({ url: '/items' });
export const viaCall = () => throughCall({ url: '/items' });
export const viaPrefix = () => prefixes({ url: '/items' });
export const viaReturn = () => throughReturn({ url: '/items' });
