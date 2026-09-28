import { Component, inject } from '@angular/core';
import { Base, Parent, Impl } from './service';
const PROVIDERS = [{ provide: Parent, useClass: Impl }];
@Component({ selector: 'a', template: '' })
export class APage { private api = inject(Base); load() { return this.api.list(); } }
@Component({ selector: 'b', template: '', providers: PROVIDERS })
export class BPage { private api = inject(Parent); load() { return this.api.list(); } }
