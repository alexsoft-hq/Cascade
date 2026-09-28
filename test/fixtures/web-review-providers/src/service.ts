import axios from 'axios';
export class Base { list() { return axios.get('/base'); } }
export class Replacement { list() { return axios.get('/replacement'); } }
export class Other { list() { return axios.get('/base'); } }
export class Alias { list() { return axios.get('/replacement'); } }
export class Legacy { list() { return axios.get('/base'); } }
