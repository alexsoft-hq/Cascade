# Web lane (frontend) setup

The web lane reads the **screen side** of the round trip. The rest of the engine
starts at the HTTP endpoint and goes down (`endpoint → service → mapper → SQL →
table → column`); this lane reads the code above the endpoint: the frontend that
calls it, and the routes that decide which screen a user is on.

**Read this first, because it is the whole shape of this version:** the lane
**attaches a frontend call to the endpoint this pack serves**, as a graded
`CALLS_HTTP` edge, and it turns the router's own declarations into **screens**,
joined to the functions of the component each one mounts. So a column-impact
answer reaches up past the controller, through the api function that calls the
route and the view that calls that function, to the screen a user is looking at.
A browser recording (`--har`) can be laid over the same edges as runtime
evidence, shown and never walked.

Every edge it writes says what it rested on, and the `web` axis is `shipped`
only when nothing about the frontend had to be guessed. A prefix this engine
worked out by counting matches, or a path alias it assumed, makes the axis
`degraded` and names what to declare.

## What it needs

**Node, and nothing else.** The parser is vendored
(`adapters/web/vendor/babel-parser.cjs`, `@babel/parser` 7.29.8, MIT), so there
is no `npm install`, no lockfile, and no network at analysis time. The
repository `NOTICE` credits it and
[adapters/web/vendor/README.md](../../adapters/web/vendor/README.md) documents
the exact bytes, the sha256 they are pinned to, and how to update them.
`cascade doctor` has a `web lane parser (vendored)` line that loads the parser
and parses one statement with it, so a truncated checkout is a named failure
rather than "0 frontend calls".

## What it reads

Under each source root, recursively: `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`,
`.tsx`, and the `<script>` blocks of `.vue` single-file components. A Vue file's
line numbers are the lines in the `.vue` file, template included, so a fact
points where you would put your cursor.

It **skips**:

| skipped | where | why |
|---|---|---|
| `node_modules`, `.git`, `.cascade` | any depth | never first-party source |
| `plugins`, `libs`, and directories named after a vendored library | any depth, in DISCOVERY | somebody else's frontend, by name. The list is `adapters/web/packs/vendor-dirs.json` |
| `__tests__`, `__mocks__` | any depth | a test is a different program, wherever it sits |
| `dist`, `build`, `coverage`, `public` | **only as a direct child of a source root, or of that root's package directory** | there they are output; deeper down they are ordinary names |
| `*.d.ts` | any | a type declaration has no call in it |
| `*.test.*`, `*.spec.*` | any | same reason as `__tests__` |
| `*.min.js` | any | a bundle, not a source |
| files over 2 MB | any | recorded as `skipped: "too-large"`, never dropped silently |

The position rule on the third row is load-bearing, not a nicety. A blanket
"skip anything called `build`" silently drops `src/views/tool/build/` — a form
BUILDER, six real screens in one of the frontends this lane was measured on. A
build directory is a build directory where output goes: at the top of the
package, or at the top of a source root. Anywhere else the word is just a word.

One consequence worth knowing: `cascade init`'s discovery uses a **blanket**
skip list (`src/core/discover.mjs`), because the same list protects the Java
lane from Gradle's `build/` output, and widening it there would let a Gradle
build directory into the Java lane. So the `webFiles` and `vueFiles` counts
discovery reports, and the counts `cascade estimate` prints from them, can be a
few files **below** what the lane reads: on one of the measured frontends
discovery counts 91 `.vue` files where the lane reads 97. The lane line printed
after a run is the measured number; the estimate's is a lower bound.

A file the parser cannot read at all is recorded as a `parse_error` with its
line, its column and the message, and it is **printed on the lane line**. A file
that fails to parse contributes no call and no route, and nothing else in the
run would say so.

Beside the source roots it also reads, once per package directory (the directory
holding the nearest `package.json`): the dotenv files (`.env`, `.env.local`,
`.env.<mode>`, `.env.<mode>.local`), `vue.config.js` and `vite.config.*` for the
dev-server proxy table, and `tsconfig.json` / `jsconfig.json` / the bundler
config for path aliases. Those three between them decide what `'/api'` in a call
actually reaches, and the bridge uses all of them.

### Server-rendered pages

A frontend router is not the only way an application has screens. In a large
share of the systems this tool is for there is no router at all: a `@Controller`
returns a view name, a template engine renders it, and the page's own `<script>`
calls the backend, its `<form>` posts to a route and its links open other
routes. The lane reads those pages too, from the **template roots** the profile
names.

| engine | extension | how the root is found |
|---|---|---|
| Thymeleaf | `.html` | `spring.thymeleaf.prefix` / `.suffix`, else `classpath:/templates/` + `.html` |
| FreeMarker | `.ftl` | `spring.freemarker.template-loader-path` / `.suffix`, else `classpath:/templates/` + `.ftl` |
| JSP | `.jsp` | `spring.mvc.view.prefix` / `.suffix`, a `ViewResolver` **bean** in a Spring XML, else where the `.jsp` files sit under `webapp` / `WEB-INF` |
| Velocity | `.vm` | `spring.velocity.resource-loader-path` / `.suffix` |
| plain HTML | `.html` | a root of `.html` pages with no engine setting and no `th:` attribute in them |

A configured prefix is a location on the class path or in the servlet context,
not a path in the repository. What it DOES say is how the directory ends, so
`classpath:/templates/` picks out `src/main/resources/templates` and
`/WEB-INF/jsp/` picks out `src/main/webapp/WEB-INF/jsp`. With nothing
configured, the root is the directory every template of one resource root sits
under, which keeps a multi-module repository's modules apart.

#### The resolver written as a bean

A Spring MVC application written before Boot puts that setting in an XML bean
definition, which is what eGovFrame does and what most of the Korean public
sector runs:

```xml
<bean class="org.springframework.web.servlet.view.UrlBasedViewResolver" p:order="1"
    p:viewClass="org.springframework.web.servlet.view.JstlView"
    p:prefix="/WEB-INF/jsp/" p:suffix=".jsp"/>
```

Discovery reads it. Same question, same record, different spelling: a bean whose
class name ends in `ViewResolver` and that sets a prefix or a suffix, read by the
file's **root element** (`<beans>`) rather than by its name, because
`dispatcher-servlet.xml`, `egov-com-servlet.xml` and `spring-mvc.xml` are the
same document and a list of names would stop at the next project's spelling. A
property written as the `p:` shorthand and one written as a `<property
name=… value=…/>` child read alike, a commented-out bean is not a bean, and a
resolver with neither a prefix nor a suffix (a `BeanNameViewResolver`) resolves a
view name against beans rather than against a directory, so it names no root.

The engine the bean renders with comes from its suffix first (`.jsp`, `.ftl`,
`.vm`, `.html`), and then from its own class or its `viewClass`
(`JstlView`, `InternalResourceView`, `FreeMarker…`, `Velocity…`, `Thymeleaf…`).

What this is worth, measured: before it,
`eGovFramework/egovframe-enterprise-business-template` shipped 92 JSPs and built
**0 screens**, and `egovframe-common-components` shipped 747 and built **1** —
in both cases because the root fell back to `src/main/webapp`, where
`uat/uia/EgovLoginUsr` resolves to nothing at all. With the bean read, they build
**84** and **657**.

**Apache Tiles is not read**, and this round looked for it rather than assuming.
Not one of the eleven eGovFrame and Nexacro repositories measured for RM55
contains a `TilesConfigurer`, a tiles definitions file or a `put-attribute`:
Apache Tiles was retired in 2021 and Spring Framework 6 dropped its support, so
eGovFrame 4.x has none. A `forward:` view name is read, and has been since RM48:
it is a call onto another route of the same application, exactly like
`redirect:`.

An `.html` file under `static/` is **not** a template: the server hands it out
as it stands, no resolver renders it, and reading every one of them would cost
the run a walk through whatever a project keeps there. A `.html` template lives
under a `templates` or a `WEB-INF` directory, or where the configuration says.

`cascade init` writes what it found into the profile's `templateRoots`, one line
says so, and a list that is already there is yours and is left alone — the same
rule `webRoots` follows. `cascade analyze` reads the roots from the PROFILE, not
from this run's discovery, because a template root decides what is in the pack
and a pack must not change under an input nobody recorded.

Four things are read out of each template, and nothing else:

- **the inline `<script>` blocks.** The template's own directives are
  NEUTRALISED first — FreeMarker's `<#…>`, `</#…>`, `<@…>` and `${…}`, JSP's
  `<%…%>`, `<%=…%>` and `${…}`, Thymeleaf's `[[…]]` and `[(…)]` — into
  placeholders that keep every line where it was, and what is left goes through
  the SAME JavaScript reader every `.js` file goes through. A block that still
  does not parse is a `parse_error` on that block and costs the run nothing. A
  `<script src=…>` is a file of its own and is never an inline block.
- **the forms.** `<form action>`, `th:action="@{…}"`, `<form:form action>`: one
  call site each, the method from the attribute and GET when there is none.
- **the links.** A `href` or `th:href` that names a path from the app root. A
  static asset is not a route and is left out by prefix (`/webjars`,
  `/resources`, `/static`, `/css`, `/js`, `/images`, `/fonts`) and by extension;
  a query string is not part of a route and is dropped; an address with a host
  belongs to somebody else.
- **the includes.** `<%@ include file>`, `<jsp:include page>`, `<#include>`,
  `<#import>`, `th:replace` / `th:insert` / `th:include`. JSP and FreeMarker
  resolve an include against the INCLUDING file's directory (a leading slash
  means the root); Thymeleaf resolves a fragment expression against the root
  always. Resolution is lexical: no file is opened, so a shard describes the
  bytes of its own file and nothing else.

**The context path is the app root.** `${request.contextPath}`,
`${pageContext.request.contextPath}`, `@{/…}`, `<c:url>` and `<spring:url>` all
name where this deployment is mounted, which is not part of any route the pack
serves. So a page's prefix is the empty string and `prefix.from` is
`context-path` — nothing had to be guessed. A page that writes
`var base_url = '${request.contextPath}'` in its layout and `base_url +
"/things/list"` in a page that includes it is read the same way: the worker
records the NAME the URL was built on, and the bridge closes the hole with the
include graph.

## What it records

One JSONL record per fact, all of them **file-local** (the worker resolves
nothing across files; that is the bridge's job):

| record | what it says |
|---|---|
| `file` | the language, the Vue script blocks, how many errors the parser recovered from |
| `import` / `export` | what this file takes and gives, dynamic `import()` included |
| `function` | the named functions, with the rule that a callback gets no name of its own and is attributed to the nearest named function |
| `constant` | an enum or object literal of string members, and `export const X = '/x'` |
| `binding` | a top-level `const` whose initializer is a call, a `new`, or another name, plus the `baseURL` when one is built there |
| `class` | a class, with the methods and fields it declares (a client written as a class is as common as one written as a function) |
| `assign` | `this.<field> = …` anywhere in a class body, with the same `init` shape a `binding` carries — this is where a class puts the client it sends through |
| `call` | a call site that goes through an import or a local binding, carries a URL-looking argument, or is `fetch` / `XMLHttpRequest.open` |
| `route` | a route declaration, with its path AS WRITTEN, its component, its parent and its child count |
| `config` | the env values, the proxy rules and the aliases described above |

A `function` also carries what it RETURNS, when the last `return` at the top
level of its body is a call or a `new` — that is how a factory (`return new
Client(opts)`) and a forwarding method (`return this.request(…)`) are followed.
A `this`-rooted callee inside a class body says which class it belongs to
(`binding: {kind: "this", class: "…"}`), so `this.inner.request(cfg)` can be
traced to the field the constructor assigned.

A `call` carries the URL argument resolved **as far as one file allows**: a
literal, a template (`'/things/' + id` and `` `/things/${id}` `` both become
`/things/{*}`), a member of a constant declared in the same file, or a local
`const` followed once. Anything it cannot resolve says why:
`parameter`, `expression` or `imported-constant`, and an imported constant keeps
the binding so the bridge can go and look.

## The flags

```
cascade analyze [--web-src <dir>... | --no-web] [--openapi <file>... | --no-openapi]
                [--har <file>...]
```

- `--web-src <dir>` — a frontend source root. Repeatable.
- `--no-web` — do not read the frontend even when the project declares it.
- `--openapi <file>` — an OpenAPI 3 or Swagger 2 document. Repeatable.
- `--no-openapi` — read no document even when the profile or discovery names one.
- `--har <file>` — a browser recording. Repeatable. See *Recordings* below.

With no flag, the lane runs over the roots discovery found, but **only when the
profile declares the `web` framework pack**. `cascade init` declares it whenever
it finds a `package.json` with a `vue`, `react`, `@angular/core` or `svelte`
dependency, and adds `vue-router` / `react-router` / `angular-router` when the
same package depends on one. The documents follow the same three-way rule with
no pack to declare: `--openapi` first, then the profile's `openapi.documents`,
then whatever discovery found.

## A frontend with no package.json

Plenty of products ship their frontend the old way: `<script src>` tags in an
HTML page, sources under `src/main/resources/static/`, and no `package.json`
anywhere. Nothing there declares a framework dependency, so the rule above finds
no package, and until RM47 the lane refused to read those files at all: the
gateway of spring-petclinic-microservices has 22 of them, nine screens and
thirteen `$http` calls, and every one of them was invisible.

`cascade init` now calls such a directory a **vendored web root** and writes it
into the profile. A directory qualifies when all three of these are true:

1. it holds at least one non-minified frontend source file, and nothing on its
   path is somebody else's code. Two lists say what that is: the ROLE names
   (`node_modules`, `bower_components`, `webjars`, `vendor`, `lib`, `dist`,
   `build`, `target`), and the names a directory of somebody else's frontend
   actually carries — `plugins`, `libs`, and the libraries everybody vendors
   (`codemirror`, `layer`, `nprogress`, `adminlte`, `select2`, …). The second
   list is a DECLARATION, `adapters/web/packs/vendor-dirs.json`, so a reader can
   add the one their tree happens to use without touching a rule; discovery
   mirrors it and `test/webfacts.test.mjs` fails if the two disagree. Measured:
   one corpus project had 13 vendored roots and 12 of them were one plugin
   directory each, another had 16 and 12; after the list they have 1 and 4, and
   both keep their own;
2. no `package.json` sits in any ancestor **inside its own repository** (a
   nested checkout starts the question again);
3. the tree says the directory is **served**: it is, or is under, a directory
   named `static`, `public`, `webapp` or `www`, or under `resources/templates`,
   **or** an `index.html` beside it loads one of its files with `<script src>`.

The roots are minimised the way the mapper and Java roots are, so a directory
and one of its children are never both read. `init` prints one line per root and
writes them to the profile:

```
frontend without a package: reading src/main/resources/static/scripts (1 root(s), 22 file(s), router angular-router). Set webRoots to [] in the profile to stop
```

One line however many roots there are: before the vendored-directory list above,
a tree that keeps plugin scripts under `static/` had thirteen of them, and
thirteen lines saying the same thing is a wall a reader skips rather than a
finding. The first five are named, then `and N more`; the count is always
exact.

```jsonc
"webRoots": [
  { "root": "../src/main/resources/static/scripts", "kind": "vendored", "from": "discovery" }
]
```

`root` is relative to the profile's own directory, like every other path in that
file. `kind` is `vendored` (discovery found it) or `declared` (you typed it).
The list is **yours the moment it exists**: a later `cascade init --force` leaves
a non-empty list alone and says what it found and did not apply, and an **empty**
list is how a project says "read none of them". `--web-src` still wins for one
run.

`cascade analyze` reads `webRoots` beside the roots a `package.json` gave, and
the census line says which is which:

```
web src/main/resources/static/scripts (profile); …
web roots from the profile: 1 vendored (no package manifest): src/main/resources/static/scripts
```

**Which framework is it?** No dependency list says, so discovery reads the
source: it opens up to 400 files under each vendored root and looks for the
registrar spellings the router packs name (`$stateProvider`, `$routeProvider`,
`$urlRouterProvider` for AngularJS; `createRouter(` / `VueRouter(`;
`createBrowserRouter(` and its siblings). What it finds goes into
`frameworkPacks`, and `cascade estimate` says so on the `web` axis:

```
web  degraded  22 frontend source file(s) in 1 root(s). 1 of those root(s) are vendored (no
                package manifest): src/main/resources/static/scripts (22 file(s)). No dependency
                list names the framework there, so the router pack is chosen from the source
                alone (angular-router). …
```

A vendored root whose source names no router is still read, and both lines say
so rather than staying quiet about it: `no router declaration in any of them` on
the `init` line, `and nothing in those roots names one` on the axis.

**A root that said nothing is reported.** A directory of somebody else's plugin
scripts looks exactly like a frontend from the outside. After the run, every
vendored root with no readable HTTP call, no route declaration and no
registration in it is named in one warning:

```
  [warn] WEB_ROOT_SAID_NOTHING 10 root(s) have no readable HTTP call and no route declaration
  in them: …/plugins/codemirror/addon/hint, …/plugins/codemirror/mode/clike, and 5 more.
  Take them out of webRoots in the profile if they are not a frontend of yours
```

## Router declaration packs

A route object has no syntax of its own: it is a plain object whose KEY NAMES a
framework decided on. Those names live in `adapters/web/packs/*.json`, one file
per convention, and the worker loads every file in that directory at start. Two
ship today:

```json
{
  "pack": "vue-router",
  "routeObject": {
    "pathKey": "path",
    "componentKeys": ["component", "components"],
    "childrenKey": "children",
    "nameKey": "name",
    "metaKey": "meta",
    "titleKey": "title",
    "redirectKey": "redirect",
    "hiddenKey": "hidden"
  },
  "registrars": ["createRouter", "VueRouter", "Router"],
  "routesKey": "routes"
}
```

An object literal is a route when it has a **string** `pathKey` and at least one
of `componentKeys`, `childrenKey`, `redirectKey`, or `indexKey` set to true, and
it sits inside an array literal, inside a registrar call's `routesKey`, or is a
top-level exported object. A file with none of the registrars still yields
routes, because plenty of projects export a plain array and register it
somewhere else.

A `jsx` block (as `react-router.json` has) says which JSX element is a route and
which attributes name its path and its component, so a `<Routes><Route …>` tree
is read as the same tree.

When two packs could both claim one object, the one whose **distinctive** keys
the object carries wins (`meta`/`hidden`/`redirect`/`name` against
`element`/`lazy`/`index`), and a registrar the file actually calls breaks a tie.
To add a convention, drop another JSON file in that directory. There is no code
to change.

### The chain form (`angular-router`)

AngularJS and ui-router do not write an array of route objects. They write a
**chain**, one call per route, each on the result of the one before it:

```js
$stateProvider
    .state('app',    { abstract: true, url: '', template: '<ui-view></ui-view>' })
    .state('owners', { parent: 'app', url: '/owners', template: '<owner-list></owner-list>' });
```

`adapters/web/packs/angular-router.json` describes that shape:

```jsonc
{ "pack": "angular-router",
  "routesFrom": "chain",
  "chain":    { "receivers": ["$stateProvider"], "method": "state", "nameArg": 0, "routeArg": 1 },
  "chainAlt": { "receivers": ["$routeProvider"], "method": "when",  "pathArg": 0, "routeArg": 1 },
  "routeObject": { "pathKey": "url", "parentKey": "parent", "abstractKey": "abstract",
                   "controllerKey": "controller",
                   "componentKeys": ["component", "template", "templateUrl"], "nameKey": null },
  "registrars": ["$stateProvider", "$routeProvider", "$urlRouterProvider"],
  "declarationCalls": [ … ],
  "registrations": { … } }
```

- **`routesFrom: "chain"`** means this pack's route objects are read only where
  its own registrar names them. `{url: '/x', template: '<y>'}` is a route inside
  a `$stateProvider` chain and an ordinary options object anywhere else, and
  without that switch every options object in the ecosystem with a `url` and a
  `component` would become a screen.
- Each link is one route, recorded at the line of its own `.state(`, not at the
  line the chain starts on.
- A state's path is its `url`, **composed onto its parent's**: the parent is the
  `parent` key, or the prefix of a dotted name (`app.owners` means `app`). The
  parent is as often in another file, so the worker records the parent's NAME
  and the bridge is what puts the two together.
- An **abstract** state is not a screen. It still composes: `/owners` under an
  abstract `app` whose url is `''` is `/owners`.
- `$routeProvider.when('/legacy', {templateUrl, controller})` is the ngRoute
  spelling of the same thing, with the path as the first argument.

### A route declaration is never an HTTP call

`$stateProvider.state('owners', {url: '/owners'})` used to come out of the
worker as a call to `/owners`, and `$urlRouterProvider.otherwise('/welcome')` as
a call to `/welcome`. On the petclinic gateway that was eight of the nine "calls
with a URL" the lane reported, and since federation those false calls even
crossed into another service. Two rules close it, and both are declarations
rather than code:

- an object argument that **any** router pack recognises as a route object
  contributes no URL to a call, whatever the callee is;
- a call listed in a pack's `declarationCalls` (`$stateProvider.state`,
  `$routeProvider.when` / `.otherwise`, `$urlRouterProvider.otherwise` / `.when`
  / `.rule`) is a declaration and sends nothing. Its arguments are still walked,
  because a real call can sit inside one.

## What the bridge does with them, and its honest grade

`src/adapters/web_bridge.mjs` runs after the Java bridge (it needs the routes)
and turns each call site into one edge per route it can be shown to reach.

| Evidence | Grade | Why |
|---|---|---|
| an OpenAPI document that declares the route | **EXACT**, as a declaration | the document is the project's own statement that the route exists, so the endpoint node is exact about THAT and about nothing else. A route the code also serves is corroborated and keeps the grade the code lane gave it; a route only the document names gets **no handler edge**, so a frontend call reaches the endpoint and stops there, and the `code` axis says `degraded` with that reason. See *OpenAPI documents* below |
| a platform sink (`fetch`, `XMLHttpRequest.open`) with a URL that matches a route this pack serves | **SOUND_SET** | the browser sends the request itself and the URL argument is the URL by contract; nothing had to decide that this is an HTTP call |
| an HTTP client library instance (a declaration pack names the library) called through one of its verbs | **SOUND_SET** | the library sends the request, and the URL is the argument the library reads |
| a **wrapper** traced back to one of those, by following what each name is bound to | **SOUND_SET** | every hop is a binding the lane read, and the hops are on the edge (`evidence.sink.chain`) |
| a URL-shaped argument handed to a call the lane could **not** trace to any sink | **HEURISTIC** | the call may send this URL or may only build it: a rule guessed |
| any of the above where the prefix was chosen by match count, a path alias was assumed, or the call has no method at all | **HEURISTIC** | one part of the answer is a guess, so the whole edge is |
| a browser recording (HAR) | **RUNTIME_ONLY** | a recording proves a request happened once and proves nothing about what the code can do, so the edge sits below every query mode's floor: it is **shown** (`observed: true`) and **never walked**, and it never raises the grade of the static edge beside it. An APM trace or an access log is still not read. See *Recordings (HAR)* below |
| a URL that resolved but no route here answers, or one naming another host | **UNRESOLVED** | the edge is below every mode's floor, so no walk follows it. The route is a node marked `outbound`, `source: "web"`, exactly as a Feign call that leaves the pack is |

A call whose URL never resolved at all gets **no edge** and is counted by the
reason the worker gave (`parameter`, `expression`, `importedConstant`). Two more
reasons come from the bridge: `noMatch` (it resolved, nothing here serves it),
`outsidePack` (another host) and `allHoles` (see below). Nothing is dropped in
silence.

### What a wrapper is

A frontend almost never calls `axios` directly. It calls its own function, which
calls another, which eventually calls the library. This lane follows that chain
by SHAPE, never by name:

- an **instance** is the library module used directly (`axios.get(…)`), a
  top-level `const` initialised from the library's own factory
  (`axios.create(…)`), or a class field assigned one (`this.inner =
  axios.create(…)`);
- a **wrapper** is a function or class method that calls a sink, or another
  wrapper, **with a URL argument that is not a literal of its own** — it
  forwards what it was given. Its depth is one more than what it calls;
- a function whose inner call spells the URL out is an **API function**, and
  that is the function the edge comes from. Wrappers get no node and no edge:
  they are plumbing, and a wrapper node would be a hub every API function
  connects to and would say nothing.

So a class whose `get(config)` returns `this.request({ …config, method: 'GET' })`
and whose `request(config)` returns `this.inner.request(config)` is followed all
the way to `axios.create`, and the edge records the chain and the depth. The
method comes from the wrapper's own verb where it has one, then from the call's
config, then from the library's documented default (`method.from` says which).

### The prefix, and how to declare it

The URL in the source is almost never the URL the backend serves. Between them
sit the client's `baseURL` and the dev server's proxy. The bridge settles it per
client instance, in this order, and the answer is on every edge as
`evidence.prefix.from`:

1. **`declared`** — the profile's `gatewayRoutes` names it. Nothing is guessed;
   the edge keeps its grade.
2. **`derived`** — the base URL was read from the source (a literal, an env
   value in a `.env` file, an absolute address's path part) and a dev-proxy rule
   explains what of it reaches the server: a rule with a `rewrite` strips it, a
   rule without one keeps it. A client built with **no** base URL is `derived`
   with an empty prefix, because that is what the library does, not a guess.
3. **`auto`** — nothing in the source states it: the base URL names an env value
   no `.env` file declares, the modes disagree with no proxy rule to settle
   them, or a relative prefix has no proxy rule at all. Every candidate is then
   matched against the routes this pack serves and the one with the most exact
   hits wins. **That is a guess**, so every edge through it is HEURISTIC and the
   candidate counts are on the edge.
4. **`none`** — even that matched nothing, so the URL is used as written.

To stop the guessing, declare the mapping in `.cascade/profile.json`:

```json
{ "gatewayRoutes": { "/dev-api": "" } }
```

The key is the prefix the FRONTEND writes, the value the prefix the BACKEND
serves. `"/dev-api": ""` says "the dev server strips it". A key of `"*"` applies
to every call in the project. Declaring it moves the axis from `degraded` to
`shipped` and the edges from HEURISTIC to SOUND_SET.

The key is applied in both places a prefix can sit: on the client's base URL,
and on the CALL PATH itself when the call carries the prefix (`$http.get(
'/api/customer/owners')` with no base URL at all, which is what a frontend
served by a gateway looks like). The longest matching key wins.

### Gateway routes you do not have to type

A Spring Cloud Gateway already states the same mapping, and `cascade init`
reads it: every route under `spring.cloud.gateway…routes` with a `Path=`
predicate becomes one entry, with `StripPrefix`, `PrefixPath` and `RewritePath`
applied to work out the back-end prefix, and the `uri` read for the service the
gateway forwards to. Both the classic key path and the newer `server.webflux` /
`server.webmvc` / `mvc` spellings are read, in YAML and in `.properties`.

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/order/**
          filters:
            - StripPrefix=2
```

...becomes:

```json
{ "gatewayRoutes": {
    "/api/order": { "to": "", "service": "orders-service",
                    "from": "src/main/resources/application.yml" } } }
```

A value is therefore EITHER the back-end prefix as a plain string, which is what
a person writes, OR that object: `to` is the same prefix, `service` is the
deployable the gateway forwards to, and `from` is the file it was read out of.
Both shapes are read by both readers, and the `service` is what lets an answer
cross into the right project when two of them serve the same path (see
[concepts](../concepts.md), "Crossings").

What is NOT read is not guessed. A `RewritePath` outside the plain
`/prefix/(?<name>.*)` form Spring documents, a filter that sets the whole
forwarded path, or a pattern with a wildcard in the middle produces a
`GATEWAY_ROUTE_UNREADABLE` diagnostic and no entry. A route table that lives in
a config server, not in the repository, is not read either, and `cascade init`
says so once.

A map that is ALREADY in the profile is yours: `cascade init --force` leaves it
exactly as it is and says how many routes it found and did not apply.

`gatewayRoutes` is read in two places: `src/adapters/web_bridge.mjs` for a
frontend call, and `src/adapters/java_bridge.mjs` for an imperative Java HTTP
call, which is the same rewrite from the other side of the wire. Declared with
neither lane to read it, `cascade analyze` says so as a `RECORDED_NOT_ACTED`
diagnostic rather than silently ignoring it.

### The HTTP client pack

Which libraries send requests, and which of their methods are verbs, is a
DECLARATION, not code: `adapters/web/packs/http-clients.json`.

```json
{ "module": "axios",
  "instanceFactories": ["create"],
  "verbs": { "get": "GET", "post": "POST", "put": "PUT", "delete": "DELETE" },
  "generic": ["request", "(call)"],
  "configUrlKey": "url", "configMethodKey": "method", "configBaseUrlKey": "baseURL",
  "defaultMethod": "GET" }
```

`"(call)"` means the instance itself is callable (`service({ url })`). To teach
the lane a library it does not know, add a row to that file. There is no code to
change, and nothing in the bridge names a library.

**A client the page LOADS.** jQuery arrives as a `<script>` tag and lands on
`window`, so no file imports it and nothing binds it either. It is a platform
sink for the same reason `fetch` is — the library sends the request itself and
says which argument the URL is — and the pack names the globals it lands on:

```json
{ "name": "jquery",
  "globals": ["$", "jQuery"],
  "config": { "methods": ["ajax"], "urlArg": 0, "urlKey": "url", "methodKeys": ["type", "method"] },
  "verbs": { "get": "GET", "post": "POST", "getJSON": "GET" },
  "urlArg": 0, "defaultMethod": "GET" }
```

`$.ajax({url, type})`, `$.ajax(url, settings)`, `$.post(url, data)`,
`$.get(url)` and `$.getJSON(url)` are call sites; `$('#x').val()` is not, because
its callee sits on the result of a call and has no root name at all, and
`$.each` is not, because the pack does not name it. It works in a `.js` file and
in a page's inline `<script>` alike.

**A client the framework hands you.** AngularJS does not let a file import its
HTTP client: `$http` arrives as a **parameter**, filled in by name, so nothing
in the file binds it and every tracing rule above sees a call on an unknown
object. The pack has an `injected` list for that:

```json
{ "name": "$http", "framework": "angularjs",
  "verbs": { "get": "GET", "post": "POST", "put": "PUT", "delete": "DELETE", "patch": "PATCH", "head": "HEAD" },
  "generic": ["(call)"],
  "registrars": ["controller", "service", "factory", "provider", "directive", "component", "filter", "run", "config", "decorator"] }
```

A parameter is that client only when **both** halves hold: it is spelled exactly
like the pack's `name`, and its function sits where the framework fills one in.
The worker recognises two such places, which are the two the framework itself
accepts: a function passed to one of the `registrars` (including a
`component({controller})`), and the inline annotation array
`['$http', function ($http) { … }]` wherever it is written. The map is inherited
downward, so `$http.get(url).then(function () { $http.post(…) })` is the same
client one scope deeper. The edge is graded **SOUND_SET**, the same as any other
declared client, and its evidence says `sink.kind: "injected"`.

That is also the one place a **relative** path counts as a URL: `$http.get(
'api/customer/owners')` has no leading slash, and a bare `get('size')` still
does not become a call. The difference is the client, not the string.

### What a URL has to look like to count

Two rules keep the graph from filling up with things that are not routes, and
both are counted rather than silently applied:

- a call the lane could not trace to any sink, whose argument is **not written
  like a path** (no leading slash, not absolute), is not an HTTP call at all:
  `Cookies.get('size')` is a verb-named call on a library that is not an HTTP
  client. Counted as `calls.notUrlShaped`;
- a URL that resolves to **nothing but interpolation** (`` `/${a}/${b}` `` →
  `/{*}/{*}`) names no route: it matches every route of that length. Counted as
  `unresolved.byReason.allHoles`, and listed in `unmatchedUrls` like any other
  miss.

### Matching a call to a route

The route path is a template (`{id}`, `{key:.+}` and `*` each take one segment,
`**` takes the rest); the call's `{*}` takes one whole segment when the segment
is nothing else, and part of a segment otherwise. Exact string equality is tried
first (`match: "exact"`), then the template match (`match: "template"`). The
method has to agree, unless the route is `ANY`; a call with no method at all
matches by path and is HEURISTIC for it.

A call that matches several routes gets an edge to each, and every one of them
carries `evidence.candidates` saying how many.

## The lane lines

```
Web lane: 120 file(s) (65 .vue, 0 .ts/.tsx, 55 .js/.jsx), 0 parse error(s); 132 call site(s) carry a URL
  (128 literal, 2 template, 1 constant, 1 unresolved), 57 route declaration(s), 2 alias(es), 1 proxy rule(s)
Web lane: 127 call site(s), 121 resolved (121 sound, 0 heuristic), 6 unresolved (noMatch 5, expression 1),
  4 outside-pack; prefix front: /admin (derived)
Web lane: 1 client instance(s), 0 wrapper(s) (deepest 0), 121 exact and 0 template match(es),
  0 call(s) through an assumed alias; bridge 6 ms
```

The first line is the worker's, the other two the bridge's. The same counts go
into `pack.meta.laneStats.web`, so what was printed and what was recorded cannot
disagree.

## Incremental: what is cached, and what never is

The lane's facts are **content-addressed per file**, exactly like the Java
lane's. A shard is one frontend source file's records; its name is
`sha256(file bytes) + the webfacts worker version + the file's root-relative
path`, so "is this still valid?" is a name lookup and never a judgement. Edit one
`.vue` and the next run re-reads that one file and reassembles the rest from the
cache.

That is safe for the same reason it is safe on the Java side: the worker
**resolves nothing across files**. It records what one file imports, exports,
binds and calls. Every cross-file step — an import resolved through an alias, a
wrapper traced to the client library it forwards to, a URL matched against a
route — happens afterwards in the bridge, over the whole assembled set, which
every run rebuilds in full.

**What is never cached** is the package configuration: the `.env*` values, the
dev-server proxy rules and the path aliases. Those describe a PACKAGE, not the
file they happen to be written in, so no file's shard could hold them honestly —
and they reshape every URL the frontend sends, so answering from a stale copy
would be the one mistake this lane cannot afford. Every run re-reads them with
`node adapters/web/webfacts.mjs --configs-only …`, which walks no source file and
costs one process start.

**What forces a cold run:**

| what moved | why every shard is dropped |
|---|---|
| the webfacts worker version | shards from two generations of a worker mean different things |
| the engine's assembly version (`cascade-incremental/N`) | the shard layout or the assembly order changed |
| the lane selection (a web root added, removed or moved) | cold and incremental must analyze the same inputs |
| `--cold` | you asked |

The invariant this buys is I-9: **an incremental run's pack digest equals a cold
run's on the same tree.** `test/incremental.test.mjs` proves it by mutating a
random subset of a synthetic project — frontend files included — and comparing
the two packs after every round.

## The working-tree overlay

`changed_impact` (and `cascade impact`) answers over the bytes on disk, not the
last analysis, and that includes the frontend.

**You edited a frontend file.** The overlay re-reads that file only, re-reads the
package configuration, splices the result over the cached shards and rebuilds the
graph. The answer runs DOWN:

- `touched.webSymbols` — the frontend functions in the files you edited, kept
  apart from the Java symbols because what is downstream of one is a route.
- `calledEndpoints` — the routes those functions call.
- `downstreamColumns` — the columns those routes reach, through their handlers.

A function no certified run has seen is marked `provisional: true` beside its
grade. That is a MARKER, not a grade: the lattice is untouched.

**You edited a backend file.** Each affected route in `upstreamEndpoints` carries
`frontendCalls`: how many frontend functions call it. That is the half of the
blast radius that is not below the edit.

Measured on the integration fixture, one edited `.vue`: **67 ms** total for the
lanes (web 63, sql 1, graph 3), against a one-second gate.

## OpenAPI documents

A document is an **evidence layer**, not a lane over source: the project wrote it
to say what it serves, and this engine reads it as a declaration.

**What is read.** A `.json`, `.yaml` or `.yml` file, at most 2 MB, whose first
4 KB carry a top-level `openapi:` / `"openapi"` or `swagger:` / `"swagger"` key.
Swagger 2 takes its prefix from `basePath`; OpenAPI 3 from the path part of
`servers[0].url` (a `{variable}` in the path is left exactly as written, because
substituting its default would invent a base path the document did not state).
Each `(method, path)` becomes an endpoint; a path item with no verb at all still
declares the path, with the method `ANY`.

**The YAML subset.** This engine has no runtime dependencies, so the YAML reader
is written here (`src/adapters/openapi_bridge.mjs`) and it is deliberately small:

| accepted | refused, by name |
|---|---|
| block mappings and sequences, by indentation | anchors (`&x`) and aliases (`*x`) |
| plain, single-quoted and double-quoted scalars | explicit tags (`!!str`, `!Ref`) |
| `#` comments, whole-line and trailing | a second document in one file (`---`) |
| flow sequences `[a, b]` and flow mappings `{k: v}` of scalars | a tab in the indentation |
| `\|` and `>` block scalars, kept as text | an unterminated quote or flow collection |

A refusal names the **line and the construct** and the whole document is then
**unread** — no half of it enters the graph. A YAML feature silently mis-parsed
would put routes in the pack that the file does not declare, which is worse than
reading no routes at all. Convert the document to JSON, or write the routes
without the construct.

**With a Java lane.** The document and the code are two independent statements
about the same routes. A route both name is CORROBORATED: the endpoint node gains
`declaredBy` (the documents that declare it, sorted) plus `operationId` and
`summary` when the document carries them, and keeps whatever grade the code lane
gave it. A route only the document names is added with **no handler edge**. The
drift census is on `meta.laneStats.openapi` and in the overview's
`openapi-drift` gap, in both directions:

- **declared and not served** — a service in another repository, or a contract
  that has moved on.
- **served and not declared** — undocumented API.

This engine reports both and judges neither.

**Without a Java lane.** This is what the layer is really for. A backend written
in something this engine has no lane for — Node, Go, Python, .NET — still
publishes a document, and the frontend's calls then land on real endpoint nodes
instead of on nothing. The pack says how far that gets you: the `code` axis is
`degraded`, with the reason *"endpoints come from an OpenAPI document, not from
source: the routes exist, but nothing below them is walked, so a frontend call
reaches an endpoint and stops there"*, and a column question answers
`not-shipped` rather than an empty list that would read as "we looked".

## Screens

A route declaration is not a screen. A **screen** is the path a user is really
on, and that path is composed rather than read: a router nests, so
`{path: '/panel', children: [{path: 'rows'}]}` is one screen at `/panel/rows`.
The composition rules, in full:

- a child path that starts with `/` is **absolute** and replaces everything
  above it;
- a parent whose path is `''` contributes nothing;
- everything else is joined with one slash, and the result is normalized (one
  leading slash, no doubled slashes, no trailing slash);
- a declaration with **no component, no children and a `redirect`** is not a
  screen at all: it mounts nothing and shows nothing;
- when two declarations compose to the same path they are ONE node, the first in
  (file, line) order, and every declaration is listed in `declaredAt`.

The node id is `screen:<the composed path>`, which is also what `flow screen=`
and `browse kind=screen` name it by.

### A page a controller renders

The other kind of screen. Where a router declares a path and mounts a component,
a `@Controller` answers a path and names a **view**, and the view resolver joins
its prefix and suffix onto that name to find the file. Every template a handler
names is a screen:

    screen:view:<the view name>          owners/findOwners, business/job.list

The `view:` prefix keeps a hybrid application's two kinds of screen apart: an
application with a Vue router AND a Thymeleaf admin has both, and neither id can
collide with the other.

| field | where it comes from |
|---|---|
| `name` | the view name the handler returned |
| `template` | the file the resolver's prefix and suffix found |
| `engine` | thymeleaf / freemarker / jsp / velocity / plain-html |
| `paths` | every route whose handler renders this page, sorted |
| `path` | the first of those |
| `label` / `group` / `code` | the same rules a router screen follows, applied to the view name |
| `source` | `view` |

A template **no handler names** is not a screen. It is a fragment somebody pulls
in, or a page nobody serves, and the run says how many of each. Its links are
nobody's calls and it draws no edge.

`symbol --RENDERS_PAGE--> screen` is EXACT: the literal the handler returned is
the view resolver's own input, so nothing was matched by name or by shape. It is
deliberately **not** a flow edge. A page's own form and links are the NEXT
request, not this one, and following them from the route that renders the page
made every route inherit the reach of every route its page links to — measured
on the corpus, what one endpoint reaches inflated by 81% on one project with no
union count moving by one. Instead the relation is taken ONE step, in the two
places that ask: `screen_impact` turns "this method reads the column" into "this
page shows it", and `flow` walking down from a route lists the page it shows
without following it.

A `redirect:` or a `forward:` is not a page at all. It names a route of this
same application, so it becomes `symbol --CALLS_HTTP--> endpoint` (GET, rule
`view-redirect`), graded by the route match like any other call.

A page's RENDERS edges are its own code and what it pulls in:

- **EXACT**, rule `template-own`, onto every function of the page's inline
  scripts — including `#(module)`, which is where a form and a link hang;
- **SOUND_SET**, rule `template-include`, onto each template the page includes
  (one row per include, whatever else the fragment holds) and onto that
  fragment's own functions. It is a candidate because which branch of the page
  really reaches the include is a run-time question.

A view name the run cannot place — a template root nobody declared, a suffix
that is not the configured one, a name built at run time — is a `VIEW_NAME_UNRESOLVED`
warning with the name on it, and a handler return the Java lane could not read
is counted on the screen axis reason. Both are gaps with a number, never a
silence.

How the name was READ rides on the edge as `evidence.from`: `literal`,
`model-and-view`, `set-view-name`, `constant` (a `static final String` of the
handler's own class) or `helper` (a private method of that class, whose name is
on the edge too). All five are EXACT, because all five are read from one file
with nothing resolved across it; see
[the java lane](java-lane.md#the-page-a-handler-renders) for what each one is
allowed to read.

### What is on a screen

| field | where it comes from |
|---|---|
| `path` | the composed path |
| `name` | the route's own `name` |
| `title` | the route's `meta.title`, only when `screenAxis.nameSource` is `route-meta` |
| `label` | the last path segment when `screenAxis.pathRule` is `last-segment`, otherwise the whole path |
| `code` | the first match of `screenAxis.codeRegex` against the name, then the title, then the path |
| `group` | the first `moduleAttribution.codeLength` characters of the code when both exist, otherwise the first path segment |
| `component` | the root-relative file the route's component resolved to |
| `file` / `line` / `pack` | the declaration itself, and which router pack recognized it |
| `params` | true when the composed path has a `:x` or a `*` in it |
| `hidden` | present only when the declaration says so |
| `source` | `router`, or `har` for a page only a recording found |

### RENDERS: what a screen actually runs

`screen --RENDERS--> symbol` joins a screen to the frontend functions it can run.
Nothing about it is guessed from a name:

- **EXACT** onto every function of the file the route DECLARES as its component.
  The route says which file it is; the function is in that file.
- **SOUND_SET** onto the functions of a file that component **imports**, directly
  or through other components, up to four levels deep, cycles cut. The edge
  carries `evidence.via`, the import chain that reached it. It is a candidate
  because which of an imported component's functions a screen really runs is a
  run-time question.
- A file nobody imports is not a child, and a route whose component this lane
  could not resolve to a file it read gets **no** RENDERS edge at all. Those are
  counted (`laneStats.web.screens.componentUnresolved`) with the specifiers that
  failed, because an alias or a missing source root is usually what is wrong.

#### When there are no imports: the framework's own name registry

A frontend written before modules resolves nothing by path. AngularJS keeps a
registry of NAMES, and a name is how one thing finds another:

```js
// the route says which TAG it mounts
.state('owners', { url: '/owners', template: '<owner-list></owner-list>' })
// the tag is a component registered under a name
angular.module('ownerList').component('ownerList', { templateUrl: '…', controller: 'OwnerListController' })
// which names a controller, registered in another file again
angular.module('ownerList').controller('OwnerListController', ['$http', function ($http) { … }])
```

The worker records each registration as a fact (`kind: "registration"`, with
`what` = `component` / `controller` / `directive`, the name, and the names it
points at), reads the HTML template a registration or a route points at
(`templateUrl`) **for its custom element tags and nothing else**, and the bridge
walks the names:

| rule | reached by |
|---|---|
| `angular-component` | the route named the component: `component: 'ownerList'`, or a `template` that is one element (`<owner-list></owner-list>`, kebab read as camel) |
| `angular-controller` | a component registration's `controller` key |
| `angular-template-tag` | a tag in the HTML template a registration points at, which is how one component mounts another |

The grade follows the resolution, not the depth: **EXACT** when every name in
the chain matched exactly one registration, because the framework itself
resolves by that exact string, the same way an import names a file;
**HEURISTIC** when a name is registered more than once, because which module
loads last is not in the source and every file that registers it is a candidate.
The chain of names is on the edge as `evidence.names`. Following tags through
templates obeys the same depth limit as the import walk.

A name **nothing registers** gets no edge and is counted, with the name, in
`laneStats.web.screens.unresolvedNames` and printed as
`SCREEN_COMPONENT_UNREGISTERED`. The petclinic gateway has exactly one: its
layout components are registered in a loop over a computed name, so no source
line states them.

A `directive` counts as a mount point only when its definition object names a
controller; every other directive is behaviour on an element. It is looked up
after the component registry, because that is the one a modern file registers
in.

**One gap, stated.** An HTML template is not a file the lane lists as a source,
so an **incremental** run that changes only a template does not re-read the file
that points at it. A cold run (`cascade analyze --cold`) sees it.

### The frontend's own calls

Between a component's function and the route it hits there is normally one more
hop: the api module. `symbol --CALLS--> symbol` is that hop, and its grade says
how the name was followed:

| grade | when |
|---|---|
| `EXACT` | a static import with a named or default specifier, followed through a relative path or a DECLARED alias to a function this lane read; or a call by name inside one file (`getList()`, `this.getList()`) |
| `SOUND_SET` | the same, but the name came through an `export *` barrel or a re-export chain, so WHICH file it came from was a choice |
| `SOUND_SET` | the function was never called here at all: it was PASSED AS A VALUE to some other call, and the receiver may call it |
| `HEURISTIC` | an ASSUMED alias was on the path |

A call onto an imported name that is **not** a function (a constant, a
component) makes no edge and is counted as `calls.notAFunction`.

**A function handed over as a value.** Plenty of frontends never call their api
function from the view at all. They hand it to a hook:

```js
const { rows, reload } = usePagedList({ api: listRows })
useSubmit(saveRow, { immediate: false })
```

No call site names `listRows`, so a rule that follows calls stops at the view.
The worker records what was handed over (`fnRefs` on the call record): an
identifier in any argument position, or the value of an object
argument's property one level deep under any key, and only when the file binds
that identifier to an import or to a function it declares itself. A member of a
namespace import (`api.list`) keeps its root and its path. A string is not a
reference, a call is already a call, and an inline arrow's body is already
attributed to the function around it.

The bridge resolves that name exactly as it resolves a callee and places
`symbol --CALLS--> symbol` with `evidence.rule: "passed-as-value"`, the `via`
(`argument` or `property`), the `key` when there was one, the specifier and the
origin. The grade is **SOUND_SET and never EXACT**, because nothing here looked
at whether `usePagedList` calls its `api`: that would mean following a value into
another module's body. An assumed alias on the path lowers it to HEURISTIC, and
a pair that is both called and passed keeps the call's EXACT answer. The target
joins the same fixpoint as a called function, so a screen can reach it.
`laneStats.web.calls.passedAsValue` counts the references that resolved and
`laneStats.web.callsByRule` splits the edges by the rule that found them, because
a grade alone cannot tell a followed call from a handed-over function.

**Only functions that reach HTTP get a node.** A function that sends a request,
or that reaches one through these edges, is in the graph; a formatter or a date
helper is counted (`laneStats.web.functions`) and left out, because otherwise the
pack doubles in size for code no question is ever about. A function in a
component file (`.vue`, `.tsx`, `.jsx`) carries `component: true`, so a tool can
tell a function in a screen from an api function. A `.ts` or `.js` module that
exports a function returning JSX is a component too, and this version does NOT
catch that: the fact stream carries no JSX marker, so the rule is the file
extension and nothing else.

### When the router is filled in by the server

Plenty of admin products fetch their menu from the backend when the app starts.
The screens this lane can see are then not the app, and the axis says so rather
than letting the ones in the source read as the whole product.

**The rule is the call**: one of the frontend's own calls resolved to a route
this pack serves whose path ends in `/getRouters`, `/menu`, `/menus`, `/routes`
or `/nav`. Nothing else is required. The census records
`serverDriven: {detected, detectedBy: "menu-call", routes, ceiling,
menuEndpoints}`, so a reader can check the rule rather than take it.

The route count does not decide, it only chooses the sentence. Under the
**30**-route ceiling the reason says *most screens arrive when the app runs*;
over it, *screens beyond the N declared arrive when the app runs*. That split
replaced a rule which needed both halves — a big frontend that fetches its menu
is server driven exactly as a small one is.

**What this still does not catch**, measured and left alone: a product whose menu
rides on an endpoint that is not spelled like one. The largest frontend measured
declares 173 routes — 87 of them the framework's own demo pages — and fetches
every business screen at run time from a route named after **permissions** rather
than after menus. No suffix above matches it, its `screen` axis reads `shipped`,
and "19 of 166 screens reach a table" reads as a shortfall rather than as a
description. Adding that project's spelling here would be a rule that works on
that project and nowhere else, so the spelling table stays generic and this is written
down instead.

When it fires the `screen` axis is `degraded` with that sentence and the numbers
behind it, and `overview` carries a `screens-from-server` gap. It is about what
is MISSING, not about whether to build: a profile with `screenAxis.enabled: true`
still builds every declared screen. Set `screenAxis.enabled: false` if you would
rather have no screen axis than a partial one.

### The profile keys

```json
{
  "templateRoots": [
    { "root": "../src/main/resources/templates", "engine": "thymeleaf", "suffix": ".html", "from": "default" }
  ],
  "screenAxis": {
    "enabled": true,
    "nameSource": "route-meta",
    "pathRule": "last-segment",
    "codeRegex": "([A-Z]{2}\\d{4})"
  },
  "moduleAttribution": { "codeLength": 2 }
}
```

- `templateRoots` is where a view name becomes a page. Each entry is
  `{root, engine, suffix, from}`: `root` is manifest-relative, `from` is
  `config` (a `spring.thymeleaf`/`freemarker`/`mvc.view` prefix named the
  directory) or `default` (the engine's documented default, applied to where the
  files actually sit). `cascade init` writes what discovery found; a list that is
  already there is yours and is left alone, and an empty list is how a project
  says "read no templates". The run prints the roots it will read before any
  lane starts:

  ```
  template roots 1 (profile): src/main/resources/templates thymeleaf .html
  ```

- `screenAxis.enabled` is the **gate**, and it has **three states**:

  | value | what it means |
  |---|---|
  | `true` | build screens, whatever this run happens to read. `cascade init` writes this when it finds a router package in the analyzed tree |
  | `false` | build none, whatever this run happens to read. Your word, and the engine does not argue with it |
  | `null`, or the key absent | decide it from what the run READS: on when `frameworkPacks` names a router pack, when a frontend package this run really reads depends on `vue-router`, `react-router` or an AngularJS router, or when the run reads a template root at all; off otherwise. This is the default |

  The third state exists for the layout `--web-src ../front/src` describes. `cascade init`
  discovers the **analyzed tree**, so a backend whose frontend is checked out beside
  it has no router package for `init` to find — and before the third state, a run
  that read that whole frontend and resolved its calls onto real routes still
  built no screen at all, for a reason that had nothing to do with the code. The
  run prints which of the three rules decided it:

  ```
  screen axis ON (read-router): screenAxis.enabled is undeclared and a frontend
  package this run reads depends on vue-router
  screen axis ON (server-views): screenAxis.enabled is undeclared and this run
  reads 1 template root(s) (thymeleaf), whose pages a controller names
  ```
- `screenAxis.nameSource` is `route-meta`, `none`, or `jsdoc-comment`. The last
  is **refused** with a diagnostic: no lane here reads the comment above a
  component, so every title would be null, and the axis is degraded for asking.
- `screenAxis.pathRule` changes only the short `label`, never the path.
- `screenAxis.codeRegex` + `moduleAttribution.codeLength` are for a project whose
  screens carry a code of their own (`AB1234`), where the first characters of the
  code name the module. Without a `codeRegex` no screen has a code, and every
  screen is grouped by the first segment of its path instead.

### When the axis is shipped

`shipped` needs all three: the gate is on, at least one screen has a RENDERS
edge, and nothing about the reading was a guess. It is `degraded` when the app
fetches its menu from the server, when more than a fifth of the declared routes name a component
this lane could not resolve, when `nameSource` asks for something not shipped, or
when screens were built and not one of them reaches a function. It is
`not-shipped` only when the gate is off or no route was read at all. When it is
off, the axis reason names which of the three rules above turned it off.

## Recordings (HAR)

A **HAR** file is what the browser saw: which page was open, and every request it
sent. `cascade analyze --har <file>` (repeatable) reads one, and the profile's
`runtimeEvidence.har` names them for an unflagged run. **Nothing is discovered**:
a recording is something you made on purpose, and picking one up because it
happens to be in the tree would let an unrelated capture decide what this pack
claims was observed.

### How to record one

In Chrome, open the app, press F12, go to **Network**, tick *Preserve log*, walk
through the screens you care about, then right-click the request list and choose
**Save all as HAR with content** (the content is not read here, only the URLs and
the page each one belongs to). Firefox and Edge write the same format.

### What is matched

- Every entry's URL is read down to its path. A request path carries the
  **frontend** prefix (`/dev-api/system/user/list`), and the routes in the graph
  carry the backend path, so the front prefix comes off and the back prefix goes
  on, using the very prefix decisions the web bridge already made for that
  package: declared, then derived, then auto, in that order.
- A **page** URL is read down to its route: a single-page app in hash mode puts
  its route in the fragment (`https://app.example.com/#/things/list`), and that
  fragment IS the screen path there. In history mode the path is.
- Static assets (`.js .css .png .woff2 .map .ico .svg`) are skipped and counted
  apart. Everything else that matches no route is **counted by path**, never
  dropped: a recording that lands nowhere is usually a prefix nobody declared.
- A page whose path matches no screen the source declares becomes a screen of its
  own, with `source: "har"`, `observed: true` and no RENDERS edge, because no
  source line says which component it mounts.

### What RUNTIME_ONLY means

Each matched (screen, route) pair becomes ONE `screen --CALLS_HTTP--> endpoint`
edge graded **RUNTIME_ONLY**, carrying `{rule: 'har', file, count, firstSeen,
lastSeen, methods}`. That grade sits below the floor of **every** query mode, so:

- **it is shown, never walked.** No chain, impact or census walk follows one. A
  recording proves a request happened once; it proves nothing about what the code
  can do.
- **it never raises a grade.** Where the static analysis already found the same
  screen calling the same route, that edge is left exactly as it was and the
  tools say `observed: true` beside it.

`observed: true` lands on the screen node and on the endpoint node, and on the
rows of `flow`, `browse kind=screen` and `screen_impact` that name them. The
census is on `meta.laneStats.har`: `{files, entries, matched, unmatched, assets,
pagesWithoutScreen, pairs, screensObserved, endpointsObserved, unmatchedPaths}`.

## What the generality gate measures

[`scripts/generality-gate.mjs`](../../scripts/generality-gate.mjs) runs this
engine, unchanged and with nothing configured, over a pinned corpus of real
repositories, and the numbers it reaches are a floor the test suite defends. Four
of those entries are a backend AND a frontend, because a backend alone says
nothing about whether a screen reaches a column. Two of the four carry their
frontend inside the backend repository, so an unconfigured `cascade init`
declares the `web` pack and the run reads it with no flag; the other two have a
frontend in a repository of its own, which the corpus pins the same way it pins
the backend (`front: {url, sha, dir}`) and the runner clones beside it, passing
one `--web-src`. Nothing else is given: no profile edit, no `gatewayRoutes`, no
document and no recording.

Two of the guarded counts are this lane's: `webCallsResolved` (the call sites
that reached a route this pack serves, over the ones that carry a URL at all) and
`screensReachingATable`. Both are real numbers for all four pairs, including the
two whose frontend is a repository of its own: the screen axis is decided by what
the run reads (the three states above), so an unconfigured run over a backend
plus `--web-src` builds screens without anybody editing a profile.

## What it does NOT do, in this version

- **No APM or server-log input.** A HAR recording is the one runtime source this
  version reads; a trace from an APM agent or an access log is not.
- **No JSX detection outside the file extension.** A `.ts` or `.js` module that
  exports a function returning JSX is a component, and this version treats only
  `.vue`, `.tsx` and `.jsx` as one.
- **No screen a route does not declare**, unless a recording found the page. A
  router filled in from the server contributes only the routes in the source, and
  the axis says so.
- **No `$ref` resolution in a document.** The routes and their `operationId` /
  `summary` are read; a `$ref` to a shared parameter or schema is left alone,
  because nothing here needs what it points at.
