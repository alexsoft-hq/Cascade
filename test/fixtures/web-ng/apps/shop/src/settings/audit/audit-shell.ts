import { Component, inject } from '@angular/core';

import { ItemService } from '@shop/data/item.service';

// A parent that has a component AND loads its children from another file.
@Component({ selector: 'shop-audit', template: '<router-outlet></router-outlet>' })
export class AuditShell {
  private readonly items = inject(ItemService);

  reload(): void {
    this.items.all().subscribe();
  }
}
