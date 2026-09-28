import { Routes } from '@angular/router';

import { appPaths } from '@shop/paths/paths';

import { ItemList } from './item-list';
import { ItemNew } from './item-new';

const { create } = appPaths.items;

export const ITEM_ROUTES: Routes = [
  {
    path: '',
    component: ItemList,
    children: [{ path: create.path, component: ItemNew }],
  },
];
