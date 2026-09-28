import { Component, inject } from '@angular/core';
import { Other, Legacy } from './service';
@Component({ selector: 'other', template: '' })
export class OtherPage { private api = inject(Other); load() { return this.api.list(); } }
@Component({ selector: 'legacy', template: '' })
export class LegacyPage { constructor(private api: Legacy) {} load() { return this.api.list(); } }
