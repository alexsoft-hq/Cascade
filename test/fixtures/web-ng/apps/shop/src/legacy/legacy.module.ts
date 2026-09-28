import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';

import { LegacyPage } from './legacy.page';

// An NgModule that registers its own routes as somebody's CHILDREN. The route
// that loads it names the module class, not a list, so this lane cannot say
// what path these hang off, and must not read them as top-level paths.
@NgModule({
  imports: [RouterModule.forChild([{ path: 'old', component: LegacyPage }])],
})
export class LegacyModule {}
