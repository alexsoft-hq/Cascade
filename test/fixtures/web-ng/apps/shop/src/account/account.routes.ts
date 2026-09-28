import { Routes } from '@angular/router';

import { extraRoutes } from './extra/extra.routes';
import passwordRoute from './password/password.route';

const accountRoutes: Routes = [passwordRoute, ...extraRoutes];

export default accountRoutes;
