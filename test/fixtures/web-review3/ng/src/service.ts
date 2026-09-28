import axios from 'axios';
import { Injectable } from '@angular/core';
// A: @Injectable's own useClass: whoever injects Base gets Mock
@Injectable({ providedIn: 'root', useClass: Mock })
export class Base { list() { return axios.get('/base'); } }
@Injectable()
export class Mock { list() { return axios.get('/mock'); } }
// B: the provider's class inherits list from a middle class
export class Parent { list() { return axios.get('/base'); } }
export class Middle extends Parent { list() { return axios.get('/middle'); } }
export class Impl extends Middle {}
// C: a subclass registered without a provider in the tree (from a spec only)
export class Plain { list() { return axios.get('/base'); } }
