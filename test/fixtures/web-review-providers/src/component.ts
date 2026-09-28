import { Component, inject } from '@angular/core';
import { Base, Replacement } from './service';
@Component({selector: 'example', template: '', providers: [{provide: Base, useClass: Replacement}]})
export class Page { private api = inject(Base); load() { return this.api.list(); } }
