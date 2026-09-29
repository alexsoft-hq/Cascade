import { http } from '../utils/http/axios';

enum Api {
  list = '/sys/user/list',
  add = '/sys/user/add',
  edit = '/sys/user/edit',
  remove = '/sys/user/delete',
  upload = '/sys/common/upload',
}

// Nothing but the URL: the step hands it on behind the options' prefix.
export const list = () => http.get({ url: Api.list });

// `params` may be text, which the step appends to the path.
export const add = (params) => http.post({ url: Api.add, params });

// `params` written as an object is never text.
export const edit = () => http.put({ url: Api.edit, params: { id: 1 } });

// Options that name no key the prefix is decided by.
export const remove = (id) => http.delete({ url: Api.remove, data: { id } }, { joinParamsToUrl: true });

// Options that set the prefix for this call alone.
export const elsewhere = () => http.get({ url: Api.list }, { apiUrl: '/other-api' });

// Options this lane cannot read.
export const withOptions = (o) => http.get({ url: Api.list }, o);

// Not through the named step: the upload step writes its own base URL.
export const upload = (file) => http.uploadFile({ url: Api.upload }, { file });
