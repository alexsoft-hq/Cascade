import { ApplicationConfig } from '@angular/core';
import { Legacy } from './service';
export const appConfig: ApplicationConfig = { providers: [{ provide: Legacy, useFactory: () => new Legacy() }] };
