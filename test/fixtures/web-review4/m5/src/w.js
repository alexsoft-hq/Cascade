import axios from 'axios';
const seen = [];
function track(u) { seen.push(u); }
// The URL string is handed to another call too: text, so the options beside it are still settled.
export const req3 = (url, o) => { track(url); return axios(url, o); };
// The options are: what they carry may be changed.
export const req4 = (url, o) => { track(o); return axios(url, o); };
