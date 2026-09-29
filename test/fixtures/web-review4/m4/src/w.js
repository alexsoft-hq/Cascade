import axios from 'axios';
export const req = (url, m) => axios({ url, method: m });
export const req2 = (o) => axios({ url: o.url, method: o.method });
