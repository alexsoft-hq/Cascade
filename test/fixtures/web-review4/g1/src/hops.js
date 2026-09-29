import axios from 'axios';
let last = null;
export function w(option) { last = option; return axios(last); }
export function v(option) { window.lastCfg = option; return axios(window.lastCfg); }
