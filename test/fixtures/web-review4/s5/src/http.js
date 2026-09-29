import axios from 'axios';
export const api = {
  post: (config) => axios({ ...config, method: 'POST' }),
  get: (config) => axios(config),
};
