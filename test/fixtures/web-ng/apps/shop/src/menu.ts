// A list of path-and-component objects in a file that imports no router at
// all. It is somebody's menu configuration, spelled the way three routers spell
// a route, and the Angular pack must not be the one that reads it.
import { HomePage } from './home/home.page';

export const menu = [{ path: '/menu-home', component: HomePage }];
