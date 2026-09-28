import { Component } from '@angular/core';

import { ItemService } from '@shop/data/item.service';

@Component({ selector: 'shop-item-list', template: '<ul></ul>' })
export class ItemList {
  constructor(private readonly items: ItemService) {}

  load(): void {
    this.items.all().subscribe();
  }
}
