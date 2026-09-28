import { Component, inject } from '@angular/core';

import { ItemService } from '@shop/data/item.service';

@Component({ selector: 'shop-settings-mail', template: '<p></p>' })
export class SettingsMail {
  private readonly items = inject(ItemService);

  load(): void {
    this.items.all().subscribe();
  }
}
