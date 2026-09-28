import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { ShopRoot } from './shop-root';

bootstrapApplication(ShopRoot, { providers: [provideRouter(routes)] });
