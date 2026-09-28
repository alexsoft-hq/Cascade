import { NgModule } from '@angular/core';
import { Other, Alias } from './service';
@NgModule({ providers: [{ provide: Other, useExisting: Alias }] })
export class FeatureModule {}
