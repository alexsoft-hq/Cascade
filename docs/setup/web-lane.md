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
worked out by counting matches, a path alias it assumed, or a base URL that
rests on a guess makes the axis `degraded` and names what to declare.

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
`.tsx`, the `<script>` blocks of `.vue` single-file components, and the
`<Script>` blocks of a Nexacro client's `.xfdl` forms and `.xjs` scripts, and the
`<script>` blocks of a WebSquare client's `.xml` pages. A Vue file's
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
actually reaches, and the bridge uses all of them. It also reads the
dependencies the package's `package.json` names, because they say which build
tool reads which of those dotenv files (see *A base URL the build decides*
below).

A workspace often keeps several applications and libraries under one
`package.json`, each in a directory with a `tsconfig.json` of its own that
says little more than `"extends": "../../tsconfig.base.json"`. So every
directory between a source file and its package that holds a `tsconfig.json`
or `jsconfig.json` gets the aliases that file means: its relative `extends`
chain is followed the way the compiler follows it, and the aliases apply to the
files under that directory before the package's own.

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
  the SAME JavaScript reader every `.js` file goes through. A JSP **custom tag**
  (`<prefix:name …>`, `<prefix:name …/>`, `</prefix:name>`) is the page's, not
  the script's, and it is taken out the same way: `<c:url>` and `<spring:url>`
  become their `value` written from the application root (an expression inside
  the value is a hole), a closing tag and a control tag (`c:if`, `c:forEach`,
  `c:choose`, `c:when`, `c:otherwise`, `c:set` and the like) become nothing, and
  every other tag becomes a value placeholder. None of them leaves a quote
  behind, which is what used to end a JavaScript string early:
  `var pagetitle = "<spring:message code="comCmm.unitContent.20"/>";` and
  `buttonImage: '<c:url value='/images/…/bu_icon_carlendar.gif'/>'` each cost the
  whole block, and measured, 348 blocks in 347 of the 739 pages of the eGovFrame
  common components (21 of 90 pages of the business template) lost every call
  their scripts make. After it, none fail. A block that still does not parse is a
  `parse_error` on that block and costs the run nothing. A `<script src=…>` is a
  file of its own and is never an inline block.
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

**A path written into the script is a path.** A template engine fills a `<c:url>`
or a `<spring:url>` in before the browser ever sees the page, so
`location.href = "<c:url value='/things/list.do'/>"` is the address
`/things/list.do` as plainly as `<a href="<c:url value='/things/list.do'/>">` is.
Every string literal a page's script hands to the URL reader goes through the
same rule an attribute does: the tag is filled in, the app's own expressions
(`${…}`) are the holes they already are, a query string is dropped, and a static
asset is not a route.

#### A form submitted from script is a request

This is the shape every eGovFrame page is written in, and there is no HTTP
client anywhere in it:

```jsp
<form:form modelAttribute="sampleVO" id="listForm" name="listForm" method="post">
…
function fn_egov_select(id) {
    document.listForm.id.value = id;
    document.listForm.action = "<c:url value='/updateSampleView.do'/>";
    document.listForm.submit();
}
function fn_egov_link_page(pageNo) {
    document.listForm.pageIndex.value = pageNo;
    document.listForm.action = "<c:url value='/egovSampleList.do'/>";
    document.listForm.method = "get";
    document.listForm.submit();
}
```

An address assigned to a form's `action`, followed by `submit()` on the same
form, is an HTTP call to that address. Rule `form-submit`.

**The same form** means the same receiver expression AS WRITTEN.
`document.listForm`, `document.forms['listForm']`, `document.forms.listForm`,
`document.all['listForm']`, `document.getElementById('listForm')`, a variable
bound to one of those (or to `getElementById('listForm') || document.forms['listForm']`,
the fallback older eGovFrame pages write for old browsers), and
jQuery's `$('#listForm').attr('action', url)` / `.prop('action', url)` followed
by `$('#listForm').submit()` are all read; two mentions of the same text are one
form. An `.action` with no `submit()` after it is **not** a call: it is a form the
user submits with a button, whose address the template reader already has from
the markup.

**One scope is all a submit reads.** A submit takes the assignment nearest before
it in the SAME scope: the enclosing function, or the module's own body, which is
one scope. The pages this idiom comes from have a search function that only
submits, beside a pagination function that assigns an address and submits:

```js
function linkPage(pageNo) { document.listForm.pageIndex.value = pageNo;
  document.listForm.action = "<c:url value='/sym/ccm/cde/EgovCcmCmmnDetailCodeList.do'/>";
  document.listForm.submit(); }
function fnSearch() { document.listForm.pageIndex.value = 1; document.listForm.submit(); }
```

`fnSearch` does not send what `linkPage` assigned. A page reloads on every submit,
so another function's assignment is gone by the time this one runs, and what it
sends is the `action` the `<form>` element carries in the markup, read by the same
reader the markup form goes through. The evidence says which it was
(`form.actionFrom`: `assigned` or `form element`). A submit whose own scope
assigned nothing and whose form element names no address this lane can read
places no edge and is counted (`laneStats.web.calls.formSubmitsWithoutAddress`),
as is one whose whole address is a page expression (`"${url}"`). The scope is the
function itself, not its name, so two functions a page happens to name alike
(`fn_x`, `fn_x~2`) are two scopes. Measured before this rule was scoped:
11 of 139 form-submit edges on the business template and 56 of 569 on the common
components had borrowed another function's address.

**The method**, in this order:

1. a `.method = "get"` / `"post"` assigned on the same form in the same scope,
   anywhere before the submit, before the address or after it. The page said so
   itself;
2. else the `method` attribute of the `<form>` element the name or id resolves
   to in the same page, where Spring's `<form:form>` sends POST and HTML's
   `<form>` sends GET. Neither default is a guess: both are written in the
   specification the page is rendered by. Spring's tag renders
   `id="<modelAttribute>"` when it is given no `id`, so
   `document.getElementById('groupManage')` finds
   `<form:form modelAttribute="groupManage">`, and so does this lane;
3. else, for a form the page built itself (`document.createElement('form')`),
   GET, which is what HTML sends when nobody assigns a method;
4. else nothing, the route is matched against `ANY`, and the evidence says the
   form element was not found in this file. A form handed in as a parameter
   (`function save(form)`) is this case.

The evidence names the form as the source writes it and where the method came
from (`assigned`, `form element`, `created by the page`, `not found`), and the census counts the sources
(`methodBySource`, `laneStats.web.calls.formSubmits`). Matching and grading are
the page's links': nothing rises above SOUND_SET on a call, because which handler
answers a path is the route table's answer and not the markup's.

Measured on the pinned corpus, this is the largest single gap the lane had:
`egovframe-sample` went from **0** calls to **8**, and its list screen from
reaching no table to reaching the one it lists; the business template reads 189
form submits (177 with an address assigned in scope, 12 with the form element's)
and the common components 1207. The receiver spellings and the method sources
above were widened once the first measurement named what was left: on the
business template the submits with no method fell from 47 to 12, and on the
common components from 281 to 98, which moved 35 and 181 edges from HEURISTIC to
SOUND_SET. Of the 98 left on the common components, 29 are a form handed in as a
parameter, 25 name a form this page does not declare, 24 use a variable declared
outside the function, 12 reach the frame around the page (`parent.document`), and
8 are other spellings.

#### In a page, `location.href` is a GET request

RM59 said the sink tells a navigation from a request and the file kind does not.
Measured, that is wrong for the browser's own global. Every `location.href` in
the eGovFrame corpus is a `<c:url>` naming a controller of the same application,
and a server-rendered page has **no router**: nothing but the server can answer
the address, so the browser goes and fetches it, exactly as it does for a link in
the same page. So in a template file `location.href = …`,
`window.location.href = …`, `location.assign(…)` and `location.replace(…)` are
GET calls with the same URL rule, rule `location-request`, matched and graded as
the page's links. In a source file they stay navigations.

An address that resolves to no path — `location.href = ""`, a `#`, a download, an
address with a host — is not a route and stays a navigation there too.


### A Nexacro client

A very large share of Korean public sector and enterprise systems has a frontend
that looks like none of the above. A screen is an `.xfdl` file: XML that declares
a form and its widgets, with the screen's whole JavaScript inside one
`<Script type="xscript5.0"><![CDATA[ … ]]></Script>` block. A shared library is
an `.xjs`, which is the same wrapper around a script nobody mounts. The
application file is an `.xadl`, and the service prefixes every url is written
against sit in the typedef XML it names.

`cascade init` calls a directory that holds `.xfdl` files a **web root of kind
`nexacro`**, and writes it to `webRoots` like any other root no package declares:

```json
"webRoots": [{ "root": "../src/main/nxui", "kind": "nexacro", "from": "discovery" }],
"frameworkPacks": ["spring-mvc", "mybatis-xml", "web", "nexacro"]
```

The root is the directory the **application** sits in, not the directory the
forms sit in, so a tree holding several applications keeps each one's name in
its screens' paths (`packageB/Pattern/Pattern_01`).

Under a Nexacro root the lane reads `.xfdl` and `.xjs` and **nothing else**. The
reason is what else is under one: a Nexacro application ships the vendor's whole
runtime beside its own screens (`nexacro14lib/`, several hundred `.js` files),
and reading those would put a framework's insides in the graph and count every
one of them as a frontend source file. A `.js` under a Nexacro root is the
runtime; an `.xfdl` and an `.xjs` are what somebody wrote.

What each file gives:

- **the screen.** One form, one screen: the `<Form id>` is what the application
  calls it, `titletext` is what a user reads on it, and its path under the root
  is its path. It renders its own script (`template-own`, EXACT) and, through an
  `include "Lib::Comm.xjs";` or a `<Script … url="…">`, the included script's
  functions one hop out (`template-include`, SOUND_SET);
- **the script.** `xscript5` is JavaScript with optional type annotations on
  parameters, so it is read with the TypeScript grammar; `include` is a Nexacro
  directive and is blanked before parsing, with its line kept. A form declares
  its handlers on `this` (`this.fn_search = function(obj, e) {…}`), and each one
  is a function record, so a call hangs off the handler rather than off the
  module;
- **the calls.** A Nexacro client sends every request through one framework call,
  `transaction(…)`, so there is no client library to trace and no wrapper chain
  to follow. Both spellings are read: the native
  `this.transaction(id, "svcurl::userSelectVO.do", inDs, outDs, args, cb)`, and
  the options object every product wraps it in —
  `Iject.transaction(this, oDatas, cb)` with
  `oDatas = { sController: "userSelectVO.do", … }`. The keys looked at are
  `sController`, `svcUrl`, `strSvcUrl`, `sSvcUrl`, `sUrl` and `url`, and they are
  a declaration in `adapters/web/lib/nexacro.mjs`, not a rule: a product with
  another spelling adds it there. The options object is resolved in the handler
  that holds it, so two handlers that both call theirs `oDatas` are two urls.

A `prefix::path` url resolves the prefix through the typedef's
`<Service prefixid url>` list, and the url's **path** part is the base:
`svcurl::userSelectVO.do` under
`<Service prefixid="svcurl" type="JSP" url="…/nexacro-sample/"/>` is
`/nexacro-sample/userSelectVO.do`. A `file`/`form`/`js` service points at the
client's own assets and answers no request, so it is not a base for a
transaction — it is what an `include` is resolved through. A bare `x.do` is the
path as written.

The edge is `CALLS_HTTP` with `evidence.rule` `nexacro-transaction`, method
`ANY` (Nexacro posts, and the route match accepts any), graded by the route
match exactly like any other frontend call. A transaction whose url is built
somewhere this lane cannot see is **counted**
(`laneStats.web.calls.nexacroUnreadable`) rather than dropped: a request that
happens and that no edge carries is a different finding from no request.

The in and out **datasets** a transaction names (75 of them in the sample read
for this) are not read, and measuring said they need not be: they are data flow
inside the browser, and what impact needs is the call, which the transaction
already carries.

### A WebSquare client

WebSquare is the other frontend a Korean public sector or financial system is
likely to be written in, and it is XML too. A screen is an `.xml` page: its
requests are declared in the model, and its script sends one by naming it.

```xml
<html xmlns:w2="http://www.inswave.com/websquare" xmlns:xf="http://www.w3.org/2002/xforms">
  <head meta_screenId="SP001M01" meta_screenName="Sample list">
    <xf:model>
      <xf:submission id="sbm_search" action="/sample/searchSample" method="post"/>
    </xf:model>
    <script type="text/javascript"><![CDATA[
      scwin.btn_search_onclick = function () { $c.sbm.execute(sbm_search); };
    ]]></script>
```

`.xml` is also the extension of a Spring context, a MyBatis mapper and a Maven
build, so a file is a page by **what it says**, not by where it is: its root
element carries the `xmlns:w2="http://www.inswave.com/websquare"` namespace.
`cascade init` calls the deepest directory that holds nine pages in ten a **web
root of kind `websquare`**, so a page template a tooling folder keeps outside the
application does not drag the root up to the repository's top:

```json
"webRoots": [{ "root": "../WebContent", "kind": "websquare", "from": "discovery" }],
"frameworkPacks": ["spring-mvc", "mybatis-xml", "web", "websquare"]
```

Under a WebSquare root the lane reads pages and **nothing else**. The engine's
own runtime ships beside the application in `websquare/` (several hundred `.js`
files, and XML pages of its own), and it is the vendor's, as `nexacro14lib/` is
Nexacro's.

What each page gives:

- **the screen.** One page, one screen. `meta_screenId` is what the application
  calls it, `meta_screenName` is what a user reads on it, and its address is its
  path under the root with `.xml` kept, because that is the address the
  application opens it by (`/ui/SP/SP001.xml`). A page whose
  `<w2:type>` is `COMMON` is a library of shared functions, not a screen;
- **the script.** Every `<script>` without a `src`, CDATA wrapper taken off, goes
  through the same JavaScript reader a `.js` does, with the page's own line
  numbers. A page declares its handlers on `scwin`
  (`scwin.btn_search_onclick = function () {…}`), and a call hangs off the handler;
- **the calls.** A call that sends a submission becomes one `call` record, with
  the address and method the `<xf:submission>` declares. Three spellings are read,
  and which calls they are is a declaration in `adapters/web/packs/websquare.json`,
  not a rule:

  | the call | names the submission by |
  |---|---|
  | `$p.executeSubmission("sbm_x")` | its id, as a string (the engine's own call) |
  | `$c.sbm.execute(sbm_x)` | the object the page binds to that id (the common library WebSquare's template ships) |
  | `$c.sbm.executeDynamic({ id, action, method })` | an options object that carries the address itself |

  A submission that names no `method` posts, as WebSquare does;
- **the navigations.** `$c.win.openPopup(url)` and `$c.win.openMenu(name, url)`
  open another page, and they are navigations, never requests;
- **no request at all:** anything under the engine's own `WebSquare.*` namespace,
  such as `WebSquare.core.getConfiguration(…)`, which reads the engine's
  configuration by an XPath.

The edge is `CALLS_HTTP` with `evidence.rule` `websquare-submission`, graded by
the route match like every other frontend call. A call naming a submission the
page never declared, or an options object this lane cannot read, is **counted**
(`laneStats.web.calls.websquareUnreadable`) rather than dropped.

What a submission sends and receives (its `ref` and `target` data lists) is not
read, for the reason a Nexacro dataset is not: it is data flow inside the
browser, and what impact needs is the call.

### Next.js: the file tree IS the route table

Next.js declares no routes. `pages/index.tsx` answers `/`,
`pages/content/[id].tsx` answers `/content/{id}`, and nothing in the source says
so. That convention is a declaration pack of its own shape,
`adapters/web/packs/next-pages.json`, whose `filesystem` entries state which
directory is the root, which extensions count, which leaf name is the directory
itself, how a parameter is spelled, which names are the framework's own, and
which subdirectory holds server handlers:

| the file | the route |
|---|---|
| `pages/index.tsx` | `/` |
| `pages/privacy/index.tsx` | `/privacy` |
| `pages/content/[id].tsx` | `/content/{id}` |
| `pages/docs/[...slug].tsx` | `/docs/{slug}/**` |
| `pages/_app`, `_document`, `_error`, `404`, `500` | not pages: the framework's own |
| `pages/api/**` | server handlers this frontend serves, counted and skipped |
| `app/**/page.tsx` | the app router, by the same rules with `page` as the leaf |

The rule fires only inside a package that **depends on** `next`, so a backend
that happens to keep a `pages/` directory of templates gets no screens out of
it. The page IS its own component — no declaration names it and nothing imports
it — so RENDERS and the page's own calls work exactly as they do for a screen a
router declares, and nothing had to be resolved. The run says both numbers:

```
the file tree: 62 page(s) declared by where they sit, 9 file(s) under the router's api directory read as server handlers instead
```

## What it records

One JSONL record per fact, all of them **file-local** (the worker resolves
nothing across files; that is the bridge's job):

| record | what it says |
|---|---|
| `file` | the language, the Vue script blocks, how many errors the parser recovered from |
| `import` / `export` | what this file takes and gives, dynamic `import()` included |
| `function` | the named functions, with the rule that a callback gets no name of its own and is attributed to the nearest named function |
| `constant` | an enum or object literal of string members, and `export const X = '/x'`. A constant whose value the build decides (an env read, a default, env reads joined, a condition over them) keeps that expression as `expr`, or `exprMembers` for an object's members |
| `binding` | a top-level `const` whose initializer is a call, a `new`, or another name, plus the `baseURL` when one is built there |
| `class` | a class, with the methods and fields it declares (a client written as a class is as common as one written as a function), and the class it extends (`extends`). `component: true` when a decorator a router pack names marks it (Angular's `@Component`) |
| `assign` | `this.<field> = …` anywhere in a class body, with the same `init` shape a `binding` carries — this is where a class puts the client it sends through. A field whose TYPE the class states (a constructor parameter property, a field set from a declared injector) is an `assign` too, with a `typed` init |
| `call` | a call site that goes through an import or a local binding, carries a URL-looking argument, or is `fetch` / `XMLHttpRequest.open`. Its URL says which argument, and which key of it, it was read from (`url.at`). Inside a named function it also says what it hands on (`hands`, with `minus` or `part` when it hands on less than a whole parameter, and `written` or `handed` when the function writes the object or hands it anywhere else), what it writes under a method key or a client's base URL key (`sets`), and what it reads apart from that (`reads`, with `open` and why when a name there is not settled, and `under` for what lands under one key of an object argument) |
| `provider` | `{ provide: T, useClass \| useExisting \| useFactory \| useValue }`, wherever it is written, a class decorator's argument included, and `@Injectable({ useClass, … })` for the class it decorates |
| `route` | a route declaration, with its path AS WRITTEN, its component, its parent and its child count, and where on its line it and its parent are (`col`, `parentCol`), since two routes can share a line. A route of a module pack also carries what joins it to other files: the list it sits in (`list`), a path written as a constant (`pathRef`), the list it loads lazily (`childrenFrom`), the export a lazy component names (`componentExport`), and `grouping` / `outlet` |
| `routeRef` | a route or a list named by NAME inside a list or under `children`, and a list a child registrar (`forChild`) registers |
| `config` | the env values, the proxy rules and the aliases described above. An alias read from a nested `tsconfig.json` carries the directory it governs (`scope`), and each package prints one `what: "package"` record with the dependencies its `package.json` names |

A `function` also carries what it RETURNS, when the last `return` at the top
level of its body is a call or a `new` — that is how a factory (`return new
Client(opts)`) and a forwarding method (`return this.request(…)`) are followed.
It also carries its `forwards`: the calls on a name the file declares that hand
on one of the function's own parameters, with what each hands on and what it
writes under a method or base URL key (see *What a wrapper is* below). A `this`-rooted callee inside a class body says which class it belongs to
(`binding: {kind: "this", class: "…"}`), so `this.inner.request(cfg)` can be
traced to the field the constructor assigned.

A `call` carries the URL argument resolved **as far as one file allows**: a
literal, a template (`'/things/' + id` and `` `/things/${id}` `` both become
`/things/{*}`), a member of a constant declared in the same file, or a local
`const` followed once. Anything it cannot resolve says why:
`parameter`, `expression` or `imported-constant`, and an imported constant keeps
the binding so the bridge can go and look. An object argument lists the keys it
writes (`names`, and `computed` when a key is written by an expression), and a
call says whether its `params` is written as an object or an array
(`params: "object"`), which a wrapper step a rule pack names is read by
(`webfacts/22`).

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
dependency, and adds `vue-router` / `react-router` / `angular-router` (AngularJS)
/ `angular-routes` (`@angular/router`) when the same package depends on one. The documents follow the same three-way rule with
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
per convention, and the worker loads every file in that directory at start. The
vue-router one:

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
is read as the same tree. An index route (`{ index: true, element }`, or
`<Route index element>` through the block's `indexAttr`) has no path of its own:
it is what its parent shows at the parent's path, so it is read with the path
`''`.

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

### The module form (`angular-routes`)

Angular 2 and later (`@angular/router`) declares its routes as a `Routes` array
of plain objects. Its keys `path`, `component` and `children` are the same words
vue-router and react-router use, so an object alone cannot say whose it is.
What says it is the file: a route file imports from `@angular/router`. So
`adapters/web/packs/angular-routes.json` is a **module pack**
(`routesFrom: "module"`, `modules: ["@angular/router"]`): it reads a route
object only in a file that imports that module, and in such a file it is the
pack that reads it. A file that imports none is read exactly as before, which
is what keeps a Vue or React project's routes as they were.

What it reads:

- `component`, and `loadComponent: () => import('./x')` (the module's default
  export) or `.then(m => m.X)` (its export `X`);
- `loadChildren: () => import('./x.routes')`, the list that module exports by
  default or the one `.then` picks;
- `children`, `redirectTo`, `title` and `outlet`;
- a route bound to a name (`const ordersRoute: Route = {…}`), which in such a
  file is a route and not somebody's configuration.

Two kinds of declaration compose and are not screens, and each is counted
(`laneStats.web.screens.lists`): a **group**, a route with children and no
component of its own (its children render in the outlet above it,
`groupings`), and a route for a **named outlet**, drawn beside the page rather
than being one (`outlets`). A class decorated with `@Component` imported from
`@angular/core` makes its `.ts` file a component, so a screen renders the
components its component imports, as candidates, as a Vue screen does.

### Routes named across files

A router that declares its routes in several files joins them by NAME, and the
bridge follows those names for every router, not only Angular's
(`src/adapters/web/route_lists.mjs`). A route's path is composed onto the path
of the route that loads or names the list it sits in:

- a lazily loaded list (`loadChildren`);
- a list or a route bound to a name and placed in another list
  (`[ordersRoute, ...errorRoutes]`);
- `children: ORDER_ROUTES`, a list written somewhere else.

A path written as a constant (`path: appPaths.orders.path`) is read through
that constant, in the same file or across an import, nested object text and
destructured names included, because the constant is still a literal somebody
wrote. A route loaded from two places is two screens.

A path that cannot be composed is not guessed. That is a constant this lane
cannot read (a `$localize` template, say), or a list registered with
`RouterModule.forChild` that no route here loads. Such a route is not a screen.
It is counted (`pathUnknown`, `pathRefsUnresolved`, `childListsWithoutParent`),
the names that could not be followed are listed (`unresolved`), and the run
prints `SCREEN_PATH_UNKNOWN` and a `SCREEN_ROUTE_NAME_UNREAD` for each of the
first five names. Past a
fifth of the declared routes, the screen axis is `degraded`.

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

### A navigation is never an HTTP call either

`router.push('/auth/login')` is the same mistake one layer up. A single-page app
changes the screen by asking its own router, and the browser sends nothing: the
component on screen is swapped for another one the app already has. Read as an
HTTP call it becomes a route nothing serves, graded UNRESOLVED, and in a pack of
several services such a false call can even try to cross into a sibling. On the
eGovFrame MSA template that was 39 of 217 "calls with a URL".

The sinks are a declaration, `adapters/web/packs/navigation.json`, because every
router spells it differently and each spelling is fixed by its framework:

| Router | What is read |
|---|---|
| `next/router`, `next/navigation` | `useRouter().push` / `.replace` / `.prefetch` |
| `next/link` | `<Link href=...>` |
| `vue-router` | `this.$router.push` / `.replace`, the same two on a name `useRouter()` was assigned to, the same two on a name imported from the app's own router module, and `<router-link to=...>` in a component's markup |
| `react-router`, `react-router-dom` | `useNavigate()(...)`, `redirect(...)`, `<Link to=...>`, `<Navigate to=...>` |
| the browser | `window.location.href = ...`, `location.href = ...`, `window.location.assign(...)` / `.replace(...)` — **in a source file**. In a server-rendered page the same sink is a GET request, because a page has no router |

What makes a call a navigation is never the NAME the code gives the router. It
is the hook it was made by (`const nav = useRouter()` reads the same as
`const router = useRouter()`), the property the framework itself puts on a
component (`this.$router`), the module a JSX element was imported from (a `Link`
from a component library is a component, not a link), the module an imported name
came from, or a global nothing in the file declares (`window.location`). A `push`
on something this lane cannot show to be a router is still a call.

**The app's own router module.** A Vue application builds its router once, in a
module of its own, and every other file writes `router.push('/x')` on a name it
imported from there — no `this`, no hook, nothing in the file saying what
`router` is. So the worker records which module IS a router and which of its
module-level names hold one: a name bound to `createRouter({routes})`, or to
`new VueRouter({routes})` / `new Router({routes})` where the class came from
`vue-router`; a name DECLARED with the router's type (`export let router: Router`,
with `Router` imported from `vue-router`, which is how an application writes a
router a setter fills at start-up); and whether the default export is one of
those or such a call handed to `export default` straight. It records a
`router.push` / `.replace` on any imported name as a CANDIDATE carrying the
specifier and the name imported. The bridge resolves that specifier through
the same module index every other cross-file question in this lane goes through.
A default import asks whether the module's default export is a router; a named
import is followed through every re-export (`export { router } from './router'`,
or `import { router } from './router'; export { router }`) to the file that
declares the name, and that file must list the name as one holding a router.
When it does the candidate is a navigation (`via` `router-module`), and when it
does not it is dropped, exactly as it was before the rule existed. `list.push(x)`
on an imported array stays what it is, even when the array is exported from the
very module the router is.

The declared type is the fact the rule rests on, not the setter. jeecg-boot
writes `export let router: Router = null as unknown as Router` and fills it in
`setRouter(r)`; following the value a setter assigns would be a guess, and the
type makes it unnecessary. Measured, jeecg-boot's navigations go from 35 to 54,
19 of them through its router module, and not one call site of any repository
changes.

**`<router-link to="/x">`** is written in a single-file component's `<template>`,
which the JavaScript parser never sees. It is read with the template reader's own
tag scanner — one element name, one attribute, no template language — over the
`.vue` file with its `<script>` blocks blanked out, so every line number is still
the line in the `.vue` file. `<RouterLink>` and `<router-link>` are the same tag.
A bound `:to` is a value the component computes and is counted as a navigation
this lane cannot follow.

The path is read as text (`push('/x')`) or off the object a router takes instead
(`push({pathname: '/x', query})`, `push({path: '/x'})`), and the query string is
not part of where it goes.

Then, and only in the bridge, the path is matched against the screens this
project declares, by the same rule that matches a call to a route: `/user/{*}`
lands on `/user/{id}` and on `/user/:id` alike. What the match produces is
**data on the screen node, not an edge**:

```json
"navigatesTo": [
  { "to": "screen:/auth/login", "path": "/auth/login", "match": "exact",
    "rule": "router-navigation", "framework": "next", "sink": "router.push",
    "file": "src/components/App/App.tsx", "line": 79 }
]
```

There is no edge because a screen change is not a hop on the round trip from a
screen to a column, and putting one on the graph would make every walk follow
it. The entry sits on the screen the navigation is WRITTEN in, which is the
screen whose component is that file. A navigation written in a shared component
belongs to no one screen, so it is counted and recorded nowhere: saying it
belongs to every screen that mounts the component would be a guess.

Three numbers say what happened (`laneStats.web.navigation`): `navigations`,
`navigationsToScreen` and `navigationsUnmatched`, with `unmatchedPaths` listing
the paths that named no screen. `bySource` says which of the rules above found
each one (`hook`, `receiver`, `global`, `import`, `element`, `router-module`,
`router-link`) and `unmatchedByKind` says why the ones that matched nothing did
not: `named` is a route the router reaches by its declared name rather than by a
path (`push({ name: 'user' })`), `bound` is a `:to` the component computes,
`path` is an address that named no screen this lane found, and `expression` is a
target the file did not state. A path that names none is a real finding either
way round: a screen this lane did not find, or a page the framework owns (Next's
`/404` is excluded from the screen list by the `next-pages` pack, so a
`router.push('/404')` honestly matches nothing).

**A server-rendered page keeps its links as GET calls**, and its address bar with
them. There a link IS a request: the browser asks the server for the next page,
and a page has no router that could answer it instead. The SINK decides
everywhere except on the browser global, where the file kind does — see "In a
page, `location.href` is a GET request" above.

## What the bridge does with them, and its honest grade

`src/adapters/web_bridge.mjs` runs after the Java bridge (it needs the routes)
and turns each call site into one edge per route it can be shown to reach.

| Evidence | Grade | Why |
|---|---|---|
| an OpenAPI document that declares the route | **EXACT**, as a declaration | the document is the project's own statement that the route exists, so the endpoint node is exact about THAT and about nothing else. A route the code also serves is corroborated and keeps the grade the code lane gave it; a route only the document names gets **no handler edge**, so a frontend call reaches the endpoint and stops there, and the `code` axis says `degraded` with that reason. See *OpenAPI documents* below |
| a platform sink (`fetch`, `XMLHttpRequest.open`) with a URL that matches a route this pack serves | **SOUND_SET** | the browser sends the request itself and the URL argument is the URL by contract; nothing had to decide that this is an HTTP call |
| an HTTP client library instance (a declaration pack names the library) called through one of its verbs, including a field whose TYPE the class declares as that client | **SOUND_SET** | the library sends the request, and the URL is the argument the library reads |
| a **wrapper** traced back to one of those, by following what each name is bound to | **SOUND_SET** | every hop is a binding the lane read, and the hops are on the edge (`evidence.sink.chain`) |
| a URL-shaped argument handed to a call the lane could **not** trace to any sink | **HEURISTIC** | the call may send this URL or may only build it: a rule guessed |
| any of the above where the prefix was chosen by match count, a path alias was assumed, the base URL or the port rests on a guess (see *A base URL the build decides* and *This machine, another port*), a wrapper step may have changed the URL, the method or the base URL without the code saying how (`evidence.sink.unsettled`), the method is not known, the call reached a catch-all route a more specific one may shadow (`catchAll`, `prefixShift`), or the route's own address is a guess (`address`) | **HEURISTIC** | one part of the answer is a guess, so the whole edge is |
| a browser recording (HAR) | **RUNTIME_ONLY** | a recording proves a request happened once and proves nothing about what the code can do, so the edge sits below every query mode's floor: it is **shown** (`observed: true`) and **never walked**, and it never raises the grade of the static edge beside it. An APM trace or an access log is still not read. See *Recordings (HAR)* below |
| a URL that resolved but no route here answers, one naming another host, or one on this machine on a port no application of this pack listens on, while every application's port is stated | **UNRESOLVED** | the edge is below every mode's floor, so no walk follows it. The route is a node marked `outbound`, `source: "web"`, exactly as a Feign call that leaves the pack is |

A call whose URL never resolved at all gets **no edge** and is counted by the
reason the worker gave (`parameter`, `expression`, `importedConstant`). Four more
reasons come from the bridge: `noMatch` (it resolved, nothing here serves it),
`outsidePack` (another host), `allHoles` (see below) and `noBuild` (see *A base
URL the build decides*). Nothing is dropped in silence.

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
config, then from the library's documented default, but the default only where
no step on the way may have written a method (`method.from` says which).
Otherwise the method is not known.
A verb whose name is not a method (`jsonp`, superagent's `del`) takes its method
from the library's verb table in the pack (`library-verb`).

A function that hands its request to the browser's global `fetch` is a wrapper
too. It was not before: a global `fetch` binds nothing, so the lane asked what
the callee resolved to, found nothing, and never reached the question of whether
the call was a platform sink. That question now comes first. A method `fetch`
reads out of an options object written before a spread
(`fetch(u, { method: 'GET', ...o })`) is a default the caller's own `method`
may replace, and a wrapper that ends at `fetch` with no method anywhere sends
`fetch`'s default.

**A wrapper written as an object's methods.** Plenty of frontends keep their
client as an object:

```ts
// config/axios/index.ts
const request = (option) => service({ ...option })
export default {
  get: (option) => request({ method: 'GET', ...option }),
  post: (option) => request({ method: 'POST', ...option }),
}
// every api module
request.get({ url: '/system/user/page', params })
```

An object literal whose functions the worker recorded (a default export, a
named `const`, or such a `const` exported as the default) is a value a name
holds, and `request.get(…)` is traced into `get` by the owner the worker
recorded, never by the key alone. The method then calls a helper its own file
declares, and a call on a local name is not a call record. So the worker writes
the calls that hand on one of the function's own parameters (as an argument,
spread into an object argument, or under a key) on the function record as
`forwards`, beside `returns`, and the bridge follows them the same way, forwards
first. Such a chain is SOUND_SET, never EXACT, like every wrapper, and
`laneStats.web.wrappers.byKind.objectMethod` counts these wrappers. A call on
`this` inside such a method is not a forward: only a call on a name the file
declares is.

**The URL, the method and the base URL, walked hop by hop.** A call through the
project's wrappers sends what the LAST call sends, and three things in it come
from the caller or from a step on the way: the URL, the method and the base URL.
Each is followed the same way, from the caller to the client
(`src/adapters/web/chain.mjs`). A step's hands move it into the next step's
parameters, or drop it. A step's sets write over it
(`adapters/web/lib/sets.mjs`): a key written AFTER what the step was handed
(`{ ...option, method: 'GET' }`) is what goes on, and one written BEFORE a
spread of a parameter (`{ method: 'GET', ...option }`) is a default that what
came in at that parameter replaces.

**Where the URL comes from.** The URL is the caller's, read where the call
record says it was (`url.at`: the argument, and the key when the argument is an
object). It reaches the client only if every hop down to it hands on the part of
its parameters the URL is in. A wrapper rarely hands its options on as they came
in: ruoyi-vue-pro's writes
`const { headersType, headers, ...otherOption } = option; service({ ...otherOption })`.
So the worker follows a parameter through what the syntax settles: a `const`
alias, a rest, a spread copy, a pattern in the signature
(`adapters/web/lib/origins.mjs`). On each call inside a named function it
records what the call hands on (`hands`, with the keys a hand no longer carries,
`minus`, or the one key of the parameter it is, `part`; `options.url` written
as a key's value is a hand too) and what it reads apart from that (`reads`).

- A hop whose hands carry the URL's part moves it along. A rest or a copy that
  does not name the caller's `url` carries it.
- A hop that names it and hands it on no other way, and writes a URL there that
  reads nothing of its parameters, has dropped it. The request that call makes
  does not ask for the caller's URL, so the call draws **no edge**. It is
  counted in `laneStats.web.calls.urlNotHandedOn`, and the run prints
  `WEB_URL_NOT_HANDED_ON` when there are any.
- A copy that writes the URL back as the parameter's own value
  (`{ ...option, url: option.url }`) carries it. One that builds it from the
  parameter (`` url: `${option.url}` ``, `option.url || ''`) wrote it, so the
  hop is not settled (see below), and the edge says so.
- A URL this lane never read (`api.post(cfg)` with `cfg` a local) is never said
  to be dropped: it is counted where an unread URL is counted
  (`unresolved.byReason`), not under `urlNotHandedOn`. Neither is one kept in a
  module `let` or a page global: that hop is not settled, and the edge says so.

**Where the method comes from.** `method.from` on the edge says which of these
it was:

- `config`: the caller's object names a verb, and every step hands that key on.
  A method the caller wrote that a step drops does not arrive. A step that
  writes what it was handed at one of its parameters
  (`axios({ url, method: m })`, `axios({ method: o.method })`) sends what the
  caller put there, when the walk carried it that far and the step is settled:
  `req('/items', 'DELETE')` is a DELETE. Where nothing was carried in, the
  method is not known.
- `wrapper-verb`: a step writes a verb after what it was handed. So does a
  write on the object before it is handed on, `cfg.method = 'POST'` or
  `Object.assign(cfg, { method: 'DELETE' })`, when it always runs (not under an
  `if`, a loop, a `&&` or a callback), puts a string there, is the only write
  that can reach the key, and the object is handed nowhere else.
- `wrapper-default`: a step writes a default, and nothing the caller handed in
  carries a method.
- `library-verb`: the verb the client is called through (`service.get(…)`), as
  the HTTP client pack's verb table states it.
- `library-default`: no method arrives and no step on the way may have written
  one, so the client sends its documented default.
- `absent`: the method is not known. Every method the path is served with is a
  candidate, each edge HEURISTIC, and the library's default is never taken for
  it. That is a method written as something other than a verb
  (`{ method: verb }`, `written: "variable"`); a caller's options that could
  carry one the lane cannot see (a spread, a name, an argument past the three a
  call record reads), with the step's default beside it as `wrapperDefault`;
  and a step that may have written the method without saying what: it writes
  the object under a method key or a key it cannot name, hands it anywhere
  else, or passes the URL on through an expression, a `let` or `this`. A spread
  of an object that is not one of the function's parameters
  (`axios({ ...defaults, ...o })`) may carry a method too: when nothing after
  it replaces it, the method is not known, with `written: "spread"`.

A step that makes more than one client call
(`if (o.upload) return axios({ ...o, method: 'POST' }); return axios({ ...o, method: 'GET' })`)
is walked once per call, and the call gets one edge for each method any of them
sends. A step whose calls lead on to different clients is not followed branch by
branch: the edge is HEURISTIC and says so (`branches`).

**Where the base URL comes from.** A base URL the request carries of its own
replaces the client instance's: one the caller writes under the client's base
URL key (`baseURL` for axios, from the HTTP client pack), one a step writes
where the write always runs, puts a string there and is the only one that can
reach the key, or one written into a client call's own options. When it is a
path, it is the prefix, `evidence.prefix.from: "request"`. When it is not a path
this lane can read (an absolute address, a name), the edge is HEURISTIC and says
so (`request-base`). A step that writes the base URL key in a way the code does
not settle (`if (o.alt) cfg.baseURL = '/v2'`, `cfg.baseURL = b`, the key written
twice) leaves the base not known: the edge is HEURISTIC and names the step and
the key (`evidence.sink.unsettled` with `why: "written"`, `key: "baseURL"`). A
spread of an object that is not a parameter (`{ ...defaults, ...o }`) leaves it
not known too, said as `request-base`.

**Settled means nothing may have written the key.** A hop that hands the object
on is settled only while nothing changes it on the way, and that is decided by
default-deny (`adapters/web/lib/uses.mjs`, with `writes.mjs` built on it): an
object is left as it was only in the shapes the code knows leave it so. Every
place a named function reads a name is classified.

- It is a READ only in those shapes: a key read as a value (`cfg.url`,
  `cfg.url.startsWith(...)`), a test or an operand (`if (!cfg.url)`,
  `typeof cfg`), a spread copy (`{ ...cfg }`), a destructuring declaration
  (`const { url } = cfg`), a `const` alias, and a read-only builtin
  (`Object.keys`, `JSON.stringify`).
- A WRITE says the key it names: a member assignment, `delete`, `++`, a target
  of a destructuring assignment or of a for-of (`({ u: cfg.url } = ...)`), and
  `Object.assign(cfg, ...)`. A method called on the object (`cfg.move()`), and
  `Object.defineProperty` or `Reflect.set` on it, may write any key.
- Every other place HANDS the object on: a call's argument, a container
  (`[cfg]`, `{ cfg }`), a store on another object (`other.cfg = cfg`), a copy
  through `? :`, `||` or `??` that is kept or passed on, a `let`, a tagged
  template. Code this reader does not follow may change it there.

A hand says which keys its object had written (`written`) and whether it was
also handed anywhere else (`handed`). A step that writes the key the URL, the
method or the base URL is under, or hands the object anywhere else, leaves that
key unsettled. A write under another key unsettles nothing, and what a call
reads under one key of an object argument can only land under that key
(`reads.under`), so `{ ...option, params: option.params }` and
`{ ...option, params: qs(option.params) }` still hand the URL on.
`{ ...option, params: qs(option) }` does not: it hands the whole object to
`qs`, which may write any key of it.

A hop the code does not settle (a local assigned again, a parameter the body
writes over, a key the step writes, an object handed anywhere else, `this`,
`arguments`, a call on the options, a return whose arguments were not read) is
taken as reaching the client, as a wrapper always was, but the edge is graded
HEURISTIC and names the step, the key and why (`evidence.sink.unsettled`; `why`
is one of `reassigned`, `this`, `arguments`, `unbound`, `deep`, `computed`,
`unrecorded`, `written`, `handed`, `branches`, `request-base`, `hop-option`,
`hop-append`). The method and the base URL behind such a step are not known
either, never a default. Such calls are counted in `calls.urlThroughUnreadHop`,
by why in `calls.unreadHopBy`, and the run prints `WEB_URL_THROUGH_UNREAD_HOP`.

**A step a rule pack names.** A framework's own client class may pass the
request through a local its hooks assign again, which the reading above rightly
does not settle, while the framework's own source says what the step does.
vue-vben-admin's `VAxios.request` is one: every call through it was HEURISTIC
and named that step (jeecg-boot: 799). A `web.wrapper-hop` rule
([rules.md](../rules.md#a-frameworks-own-wrapper-step)) names such a step by the
shape of its class, never by a name, and says what it does to the URL, the
method and the base URL; the `vben-admin` pack holds the one for
vue-vben-admin. The walk reads the step as the rule says only where its client
call hands the client a local the step assigns again. Then the verb the
caller's verb method writes arrives (`method.from: "wrapper-verb"`), and the
URL arrives behind the prefix the step's request options decide (see *The
prefix, and how to declare it*). A call whose own options may set that prefix,
or whose `params` may be text the step appends to the path, is not settled and
says why (`hop-option`, `hop-append`). The edge names the rule and the step
(`evidence.sink.hop`), and `laneStats.web.calls.throughNamedStep` counts, per
rule, the calls through a named step and how many of them it settled. A step no
rule names stays as its code reads.

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
   them, a relative prefix has no proxy rule at all, or the call goes through a
   wrapper step a rule pack names, whose prefix request options decide that this
   lane does not read. Every candidate is then
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

The prefix a named wrapper step puts before the URL is only declared by `"*"`.
Until it is, a call through the step is placed behind the step's view of the
client with the prefix chosen by match count (`evidence.prefix.from: "auto"`,
with `evidence.prefix.hop` naming the rule and the option keys), and the prefix
census (`laneStats.web.prefix`) lists that view beside the client. On
jeecg-boot, 800 calls go through the named step and 278 of them are settled.
With the default profile its web axis went from shipped to degraded, because
the prefix is no longer taken as empty, and 41 fewer `CALLS_HTTP` edges are
HEURISTIC (643 to 602) now that the verb arrives. With
`gatewayRoutes {"*": ""}` declared, the named step took SOUND_SET `CALLS_HTTP`
edges from 119 to 287, and conservative screens reaching a table from 8 to 23
of 181.

The key is applied in both places a prefix can sit: on the client's base URL,
and on the CALL PATH itself when the call carries the prefix (`$http.get(
'/api/customer/owners')` with no base URL at all, which is what a frontend
served by a gateway looks like). The longest matching key wins.

### A base URL the build decides

A frontend rarely writes its server's address as one literal. It reads an
environment value, often with a literal to fall back on, and what that value
holds depends on the build. All of these are read:

```js
const API_BASE_URL = process.env.API_URL || 'http://localhost:8080/api'  // a default
baseURL: import.meta.env.VITE_BASE_URL + import.meta.env.VITE_API_URL    // env values joined
baseURL: process.env.NODE_ENV === 'production' ? process.env.BASE : '/'   // a condition
const { base_url } = config  // at module scope: base_url is config.base_url
```

Which `.env` files a build reads, in which order and for which mode, is each
build tool's own documented rule, so it is a declaration:
`adapters/web/packs/build-env.json`. The tool is the first row whose dependency
the package's `package.json` names (Next.js, Create React App, `@ngx-env`, Vite,
Vue CLI, the Angular CLI, which reads no `.env` file at all), and a package that
names none of them is read in the order Vite and Vue CLI share. The builds are
the tool's own modes (`development`, `production`), plus, for a tool that takes
`--mode`, each mode a `.env.<mode>` file names.

The lane reads a base URL into one outcome per branch and per build: a path, a
host, and what it rests on.

- When every outcome gives one path, that path is the prefix, `derived`. For a
  base URL with a default or a condition in it, the reads are on the edge as
  `evidence.prefix.reads` (the branch, the file, the modes), so a reader can see
  whether the literal was the one used.
- When the outcomes give different paths, only a dev-proxy rule settles it, as
  before; otherwise the prefix is `auto`.
- Parts are joined only within one build. A client's base URL and an
  environment value at the front of a call's path are joined only in a build
  that sets both; when they hold in disjoint builds, the call is unresolved
  (`unresolved.byReason.noBuild`), never a path mixed from two builds.
- A base URL some builds set and others set nowhere is a candidate per build.
  When every value read comes from a build's own `.env` file, a build whose
  files do not set it makes the client with no base URL, and sends the path as
  written. So the call is placed twice: behind the value for the builds that set
  it, and bare for the others, each a candidate only for its own builds.
- A base URL written as a name (`baseURL: API_BASE`) is followed to where the
  name is declared, through imports.
- An environment value at the FRONT of a call's own URL
  (`API_BASE_URL + '/polls'`) is a base URL written at the call site. It is put
  in only when every build gives it one path. One in the middle of a path, or
  one the builds disagree about, stays an `env` hole.

**This machine is not another deployable.** An absolute address on `localhost`,
`127.0.0.1`, `0.0.0.0` or `[::1]`, with any port, is a backend's development
server (the pack's `localHosts`). A call to one is matched against this pack
instead of being left outside it. Which port means which service is the next
section.

**Five things a base URL or an address can rest on are guesses.** Every edge
built on one is HEURISTIC, with `guess` on `evidence.prefix` (a client's base
URL) or on `evidence.url` (a call's own address, or the front of its URL), and
the `web` axis is `degraded` with a reason that says what to do:

| `guess` | what the value rests on | what the axis tells you to do |
|---|---|---|
| `fallback` | in at least one build, the literal of `X \|\| 'lit'`, because no `.env` file that build reads sets X, or one writes it empty (`X=`: the empty string is falsy, where `X ?? 'lit'` keeps it). A shell, a CI job or a container may set it, and nothing in the tree can show that nothing does | set the value in a `.env` file the build reads |
| `deployment-host` | every build names a host that is not this machine, and which code answers there is not in the source. When one build opens the same path on this machine, the remote builds are read as that backend deployed, and there is no guess | give the development build an address on this machine in a `.env` file, or declare `gatewayRoutes {"*": "<back>"}` |
| `assumed-alias` | the base URL was read from a module reached through an import alias this engine assumed | declare the alias |
| `port-default` | this machine, on a port no file states, while an application's port rests on Spring Boot's default (see the next section) | state `server.port` in that application's configuration, or declare its port in the profile's `servers` |
| `port-unknown` | this machine, on a port no file states, while an application's port is not known | declare that application's port in `servers` |

### This machine, another port

`http://localhost:8081/owners` and `http://localhost:8082/visits` are both this
machine. In a repository with more than one backend, the port is what tells the
services apart. So discovery reads `server.port` from each Spring application's
own configuration (`application*` and `bootstrap*`, in `.yml`, `.yaml` or
`.properties`), every profile included, because each profile is one way the same
application runs. An application is the `resources` directory its configuration
sits in. Where no document that applies without a profile sets the port, the
application also listens on Spring Boot's documented default, 8080.

**A deployment file is one more way the application runs**, like a profile
(`src/core/server_ports_deploy.mjs`). A `Dockerfile` (also `Dockerfile.x` and
`*.dockerfile`) that starts it with `--server.port=9090`, `-Dserver.port=9090`
or `ENV SERVER_PORT 9090`, and a compose file (`compose.yml`,
`docker-compose.yml` and their variants) that sets `SERVER_PORT: 9090`, give a
port read beside the configuration's. A line that starts with `#` is a comment,
and a file under a test path is not read. A deployment file speaks for the
applications under its directory, or for every application when it sits beside
none. One that sets the port from elsewhere (`--server.port=${ADMIN_PORT}`)
makes it not known. A port a deployment file states does not take away the
default: without it, the application still listens on 8080.

While every application's port is stated, a call to this machine on a port it
WRITES that no application of this pack listens on is another service's call:
in its own address, in its client's base URL in every build, or in an
environment value at its front. It stays outbound, graded UNRESOLVED with
`target: "outside-pack"`, and `evidence.away` names both ports and the file that
set them. When its path is one this pack also serves, the edge lands on that
route's node, still UNRESOLVED, so no walk follows it. The same port, or no port
written: as before. When a port is not known or rests on the default, see *What
decides nothing* below.

**Code can set the port too.** A Java or Kotlin source is read with its comments
taken out (`src/core/server_ports_java.mjs`), and it belongs to the application
whose `src/main/resources` sits beside its `src/main/java` or `src/main/kotlin`,
the top of the repository included. What sets a port in code is a list of data,
`PORT_SET_IN_CODE`: `setPort` on a web server factory, `setDefaultProperties`
on the application, and a string that names the key as it is set
(`"server.port"`, `"--server.port=..."`, `"-Dserver.port=..."`) anywhere in the
code: a map entry at any place, a constant, a system property, a builder
argument. The one exception is the argument of a read (`getProperty`,
`getRequiredProperty`, `containsProperty`). A hit makes that application's port
unknown, with the rule's own words as the reason. A `@PropertySource` that
names a file on the classpath is looked for in the tree, under that
application's `resources`, and read like any configuration file: one that sets
no port changes nothing. One outside the classpath, one written with a
placeholder, or one the tree does not hold makes the port unknown.

An application's port is not known when a `server.port` is a placeholder
(`${PORT:8080}`) or not a number, when it is `0` (the application picks a port
when it starts), when a deployment file sets it from elsewhere, when the
application takes its configuration
from outside the tree (a config server, Nacos, Consul, ZooKeeper), when it
points at configuration this reader does not follow (any
`spring.config.import`, a classpath file included, `spring.config.location`,
`additional-location` or `name`, a profile key with a placeholder), or when
code sets it as above. With no Spring configuration read at all, no port is
known either.

**What decides nothing, and what is then not settled.** Two things leave a call
where its path puts it, whatever port it writes, but not as a fact:

- One application whose port is not known. A call on a port no application
  states may be that application's or another service's. It stays this pack's
  candidate, HEURISTIC, with `url.guess: "port-unknown"`. The ports the other
  applications state are still read and printed beside the reason, and a call
  on one of them is settled.
- A port that rests on Spring Boot's default. Whatever starts the application
  may set another, so no call is another service's on the strength of 8080
  alone, and a call on a port no file states, 8080 included, is this pack's
  only on an assumed default: HEURISTIC, with `url.guess: "port-default"`.

A call on a port some configuration or deployment file states is settled as
before. The web axis names the base URLs and call URLs that rest on a port
guess (`causes: ["port-default"]` or `["port-unknown"]`) and says which
application to declare.

**Saying the port the source does not.** When an application states no
`server.port`, or states one a deployment fills in, its port is what whoever
starts it chooses, and the tree cannot say it. The profile can:

```json
"servers": { "mall-admin": { "port": 8080, "from": "the deployment runbook" } }
```

The key is the directory that holds the application's `src/main/resources`,
relative to the analyzed root (`"."` for its top); that resources directory
itself (`mall-admin/src/main/resources`) is taken too. `port` is 1 to 65535 and
`from` is a note for the reader; an entry takes no other key. The declared port
is used INSTEAD of what the tree says about that application, including a port
the tree leaves not known, and it is a STATED port: a call on this machine to it
is settled (SOUND_SET where the route matches), and a call to another port is
another service's, with `servers["mall-admin"] in the profile` named as where
the port came from, while no other application rests on the default or is not
known. An entry that names no application this run read is not applied and is
warned as `SERVERS_UNUSED`. `laneStats.web.ports` records `declared` (with the
ports the tree states), `unused`, and `assumed` (the applications whose port
still rests on the default, by the key an entry would name them with), and
`stated` lists every port a file or the profile states, never the default. On
mall with mall-admin-web, the port guess took 166 `CALLS_HTTP` edges from
SOUND_SET to HEURISTIC and conservative screens reaching a table from 44 of 54
to 0; declaring `servers {"mall-admin": {"port": 8080}}` brings back all 166
SOUND_SET and 44 of 54, with the pack digest mall had before.

`cascade analyze` prints the ports and the files they came from, or why they are
not known, one line per declared port, and warns `WEB_OTHER_PORT` with the count
when a call went to another port:

```
Web lane: this pack listens on port(s) 8080 (server.port in src/main/resources/application.properties)
Web lane: mall-admin/src/main/resources listens on port 8080, as servers["mall-admin"] in the profile states
```

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

`RewritePath` is read in the form Spring's own reference shows, and the
reference shows it with a backslash:

```yaml
            - RewritePath=/portal-service/(?<segment>.*), /$\{segment}
```

The backslash is not a typo. Spring resolves `${...}` in a configuration value
as a property placeholder before the gateway ever sees it, so `$\{segment}` is
what a YAML author has to write for the gateway to receive the capture
reference. All three spellings mean the one group and all three are read:
`/${segment}`, `/$\{segment}`, and `/$\\{segment}` (the same value after one
more level of quoting). `/$1` with an unnamed `(.*)` group is the same rule
again.

The pattern may put the separator on either side of the prefix. `Path=/portal-
service/**` names the prefix `/portal-service`, and the rewrite above writes
`/portal-service/` — the prefix WITH its separator — so what it forwards is
everything under the prefix with the service name taken off the front. Both
spellings read as the same prefix rule.

What is NOT read is not guessed. A `RewritePath` outside the plain
`/prefix/(?<name>.*)` form Spring documents, one whose pattern starts somewhere
else entirely, a filter that sets the whole forwarded path, or a pattern with a
wildcard in the middle produces a `GATEWAY_ROUTE_UNREADABLE` diagnostic and no
entry. A route table that lives in a config server, not in the repository, is
not read either, and `cascade init` says so once.

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

**A client known by its type.** Angular's `HttpClient` is never built by the
file that uses it: a class asks for it by TYPE and the framework hands it an
instance. So a library row can name the types an instance is declared with:

```json
{ "module": "@angular/common/http", "instanceTypes": ["HttpClient"],
  "verbs": { "get": "GET", "post": "POST", "jsonp": "GET", … },
  "generic": ["request"], "positional": { "request": { "methodArg": 0, "urlArg": 1 } } }
```

A field holds such an instance when the class states its type in one of two
ways, and the type is imported from that module under one of `instanceTypes`:

- a constructor parameter property, `constructor(private http: HttpClient)`,
  which is TypeScript's own field declaration;
- a field set from an injector `adapters/web/packs/injection.json` names,
  `http = inject(HttpClient)` with `inject` from `@angular/core`.

A parameter carrying a decorator (`@Inject(TOKEN)`) is not read: the token
decides what it holds, not the type written beside it. A call through such a
field is **SOUND_SET**, and `evidence.sink.typed` says which way the type was
stated (`constructor-parameter` or `injector`). The module itself is not a
client, since `HttpParams` and `HttpHeaders` come from it too. `positional`
says `request(method, url, options)` takes its method and URL by position; a
method that is not a verb written out is no method, and the edge is HEURISTIC.

### A URL built on a constant

Most frontends do not write the path at the call site. They write it once, at
the top of the file, and every call is that name plus what the caller passes:

```ts
const POSTS_URL = '/board-service/api/v1/posts'

export const boardService = {
  getPost: (id) => axios.get(`${POSTS_URL}/${id}`),
  getComments: (id) => axios.get(`${POSTS_URL}/${id}/comments`),
}
```

Read letter by letter that template is `{*}/{*}`, which names no route, so those
calls used to reach nothing at all. A hole that is a **name this lane can follow
to text** is now filled in, and the edge says what went in:

```json
"url": {
  "written": "{*}/{*}",
  "template": "/board-service/api/v1/posts/{*}",
  "substituted": [{ "name": "POSTS_URL", "value": "/board-service/api/v1/posts", "from": "same-file" }]
}
```

The value is always a literal somebody wrote, so the substitution states a fact
rather than a guess, and the call is graded on its route match as any other call
is. `from` says where the literal was read: `same-file` is the worker's answer,
`import` the bridge's, because following an import needs the aliases and the
export chain and one file has neither. The chain is followed as far as it goes
(`ROOT` into `V1` into `REPORTS_URL`) and stops on a circle. Only a `const`
counts: `let t = '0'` and an `if` that assigns `t` again is real code, and the
initializer is not what the name holds.

**A hole that stays a hole says which kind it is**, in `url.holes` on the fact
record and counted per kind in `pack.meta.laneStats.web.url`:

| kind | what it is | why nothing fills it |
|---|---|---|
| `parameter` | a value the enclosing function was handed (`id`, `page`), or a variable of its own | it is not stated where the call is written, and it is usually the route's own hole |
| `env` | `process.env.X`, `import.meta.env.X`, or a constant bound to one | an environment value is a deployment fact, not a source fact |
| `call` | a call (`${slug(id)}`) | what it returns is a program, not a spelling |
| `import` | a name another module exports that this run could not follow | the specifier led out of the project, or what it names is not a literal |
| `unknown` | anything else | there is no name to follow |

An `import` hole left over is the actionable one: it usually means an alias this
run did not read (see [the flags](#the-flags)) or a constant that is itself
built on `process.env`. `laneStats.web.url.substituted` counts the other half,
by where each literal was read.

### What a URL has to look like to count

Three rules keep the graph from filling up with things that are not routes, and
every one of them is counted rather than silently applied:

- a call the lane could not trace to any sink, whose argument is **not written
  like a path** (no leading slash, not absolute), is not an HTTP call at all:
  `Cookies.get('size')` is a verb-named call on a library that is not an HTTP
  client. Counted as `calls.notUrlShaped`;
- a call the lane could not trace to any sink whose callee **takes a path apart
  instead of asking for one**: `pathname.startsWith('/auth/login/naver')` asks
  where the browser already is, and `p.split('/')`, `s.replace('/a', '/b')` and
  `re.test(path)` are how every frontend reads a path. There the argument really
  is a path, so the rule above cannot help; the METHOD name is what settles it.
  The list is `startsWith`, `endsWith`, `includes`, `indexOf`, `lastIndexOf`,
  `match`, `test`, `replace`, `replaceAll`, `split`, `localeCompare`, `padStart`,
  `padEnd`, `concat`, and no client verb any declaration pack names is on it (a
  test holds the two lists apart). Counted as `calls.stringMethod`. A call that
  DID reach a client is untouched: there the sink is the library, and this rule
  is about a call that has no sink at all;
- a URL that resolves to **nothing but interpolation** (`` `/${a}/${b}` `` →
  `/{*}/{*}`) names no route: it matches every route of that length. Counted as
  `unresolved.byReason.allHoles`, and listed in `unmatchedUrls` like any other
  miss. The constants are put in first (see above), so this is what is left
  after that.

### Matching a call to a route

The route path is a template (`{id}`, `{key:.+}` and `*` each take one segment,
`**` takes the rest); the call's `{*}` takes one whole segment when the segment
is nothing else, and part of a segment otherwise. Exact string equality is tried
first (`match: "exact"`), then the template match (`match: "template"`). The
method has to agree, unless the route is `ANY`; a call with no method at all
matches by path and is HEURISTIC for it.

A call that matches several routes gets an edge to each, and every one of them
carries `evidence.candidates` saying how many.

**A catch-all a path prefix nobody declared may shadow.** In a pack whose
controllers get a path prefix that configuration code sets and the profile does
not declare (`pathPrefixes`, see [the Java lane](java-lane.md)), a call that
only `/**` catch-all routes match may really be meant for a concrete route
behind that prefix. So the call's leading segments are taken off, the shortest
drop first, and a concrete route that then matches is a candidate too. Both
edges are HEURISTIC: the catch-all's says so in `evidence.catchAll`, the other's
in `evidence.prefixShift` (the segments dropped), with `match: "exact-shifted"`
or `"template-shifted"`. A call no drop finds a concrete route for keeps the
catch-all as its only candidate, graded as before. Declaring `pathPrefixes`
settles it. On ruoyi-vue-pro, 2,388 of 2,400 calls onto `DefaultController`'s
catch-alls moved from SOUND_SET to HEURISTIC and gained 2,390 candidates on the
concrete controllers; the 12 with no more specific route stayed SOUND_SET.

**A route whose own address is a guess.** A route whose lane could not settle
its address (a NestJS global prefix with an exclude this engine cannot read)
says so on its `HANDLES` evidence (`address`). A call matched to it is graded
no higher than that, and says why in its own `evidence.address`, so every walk
reads the doubt on the call's link.

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
disagree. Below them come `WEB_URL_NOT_HANDED_ON` when a wrapper did not hand a
call's URL on, `WEB_URL_THROUGH_UNREAD_HOP` when a URL, a method or a base URL
passed a wrapper step the code does not settle, one line per rule that names a
wrapper step with the calls it settled, and the ports this pack listens on, or
why they are not known, with one line per port the profile declares (see *This
machine, another port*).

### What the web axis says

The `web` axis is `shipped` when nothing about the frontend had to be guessed.
It is `degraded` when no call reached a route this pack serves, or when part of
what did rests on a guess:

- a prefix chosen by match count, or not found even that way (`auto`, `none`),
  the prefix a wrapper step a rule pack names puts before the URL included
  (declare `gatewayRoutes {"*": ...}`);
- a call through an alias this engine assumed;
- a base URL or an address that rests on a guess (the table in *A base URL the
  build decides*), a port on this machine that no file states included (declare
  the port in `servers`);
- calls traced to no client at least as many as the calls traced.

A degraded axis carries `causes`, one word per thing that degrades it:
`prefix-by-count`, `alias-assumed`, each guess a base URL or an address rests on
(`fallback`, `deployment-host`, `assumed-alias`, `port-default`,
`port-unknown`), and `untraced`. Its reason names the fix, for a port guess the
application to declare (`declare servers {"mall-admin": {"port": 8080}}`), and
where every cause is a port guess, the overview's `axisRemedies.web` gives the
`servers` key with that example. An axis degraded because no call reached a
route this pack serves carries no `causes`.

A few untraced calls do not degrade the axis. Each is still an edge, graded
HEURISTIC and saying so on itself. They are said in a **note** on the axis
instead, and an axis note rides on every answer as a limit even when the axis
shipped: how many call sites were traced to no client, the main reason, and a
callee it happened on. The reasons are counted on
`laneStats.web.untraced.byReason`, and the five commonest callees with their
reason on `untraced.callees`:

| reason | the function called |
|---|---|
| `unbound` | is bound to nothing this lane follows (an object of functions, a parameter, a global) |
| `external` | comes from a package the HTTP client pack does not name |
| `not-a-wrapper` | is the project's own, and hands the request to no client this lane knows |
| `not-a-verb` | is a client, called through a method that is not one of its verbs |

A call whose wrapper drops its URL is not among them: it draws no edge at all,
and `WEB_URL_NOT_HANDED_ON` counts it.

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

**What else the overlay reads, and what it does not.** It builds from the
inputs the base pack was built from, so a change no diff of the analyzed root
reports never reads as your edit. It reads the OpenAPI documents the base pack
read, as they are on disk now, and runs the OpenAPI bridge on them as `analyze`
does, so a document's routes and the contract links on them (see *OpenAPI
documents* below) survive an edit; an edited document is an edit to the routes
it declares. It hands the bridge the frontend packages, the server ports and
the `gatewayRoutes` of the profile the base pack was built with, as `analyze`
does, so an overlay over no edit builds the graph the pack holds, and a call the
pack left outbound because of its port stays outbound.

- **A frontend in a repository of its own**, beside the analyzed root or nested
  inside it. `analyze` records the commit it read that repository at, beside
  the fact index, and that commit is part of the pack's pin, so a run over the
  same backend and a frontend at another commit is a `REPIN` to the calibration
  gate, not a nondeterminism. Its uncommitted files are the pack's dirty files
  (`meta.base.dirtyFiles`), so the pin says dirty, and the overlay always reads
  them again: an edit you then undo is seen as undone. When that repository has
  moved on, the overlay is discarded and the answer is `behind`, as when the
  backend's HEAD moves. A frontend outside the analyzed root that is in no
  repository at all is said in `limits`: the overlay cannot tell what changed
  there.
- **A profile that changed since** (a new `gatewayRoutes` entry, say) declines
  the overlay and names the profile, because over another profile a changed
  prefix would read as your edit. Run `cascade analyze`.
- **Packages and ports are not decided again.** An edited `package.json` near a
  frontend is named in the answer's `limits`. So is, when the pack read ports,
  an edited Spring configuration, a file the base pack read a port from, a file
  it named as the reason a port is unknown, any other `.properties`, `.yml` or
  `.yaml` file outside the test tree that now states a port, and a Java source
  that now loads configuration (`@PropertySource`) or sets the port in code. The
  ports the profile's `servers` declares are kept as the base pack read them. A
  pack built before it recorded its packages says so too.

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

**Saying a document is in step with the code.** The source cannot say that a
document is current. Two profile keys say it, one per direction, each a list of
documents named as `openapi.documents` names them:

- `openapi.generatedFromCode`: a build writes the document from this code as it
  is now (springdoc does). A Spring functional route that only the document's
  operation id places is then graded as its handler is read (see [the Java
  lane](java-lane.md#routes-built-with-calls-functional-endpoints)).
- `openapi.generatesCode`: the build generates this code's interfaces from the
  document (openapi-generator does). A contract link on it is then EXACT when
  the interface's name holds whatever the generator groups operations by (see
  *Contract-first backends* below).

A declaration the other way settles nothing: a document written from the code
says nothing about generated interfaces, and one that generates them says
nothing about where hand-written code mounts a route. The validator refuses a
document written the same way in both lists. An entry that names no document the
run read is warned as `OPENAPI_DECLARATION_UNUSED`. Without either key, `cascade
analyze` names what rests on an undeclared document, `ROUTE_MOUNT_FROM_DOCUMENT`
for the functional routes and `CONTRACT_FROM_DOCUMENT` for the contract links,
each with the key that settles it.

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
gave it. A route only the document names is added with **no handler edge** of
its own; a rule may still give it one, as the next paragraphs say. The
drift census is on `meta.laneStats.openapi` and in the overview's
`openapi-drift` gap, in both directions:

- **declared and not served** — a service in another repository, or a contract
  that has moved on.
- **served and not declared** — undocumented API.

This engine reports both and judges neither.

**Contract-first backends.** A Spring project built contract-first keeps its
API in the document, and openapi-generator writes one interface per group of
operations at build time (`OwnersApi`), which the project's controllers
implement. The source tree never holds those interfaces, so the Java lane sees
controllers with no mapping, and the document's routes have nothing under them.
The rule `openapi-generator.spring-interface` pairs the two by the generator's
naming, for a class the framework serves (`@RestController`, `@Controller`)
only, and draws a HANDLES edge graded **HEURISTIC**, with the rule, the
operationId, the documents and the interface on its evidence. With the document
declared in `openapi.generatesCode`, the link is EXACT when every way the
generator may group operations (by tag or by path, a setting not read) that
gives some operation the interface's name puts this operation into it;
otherwise it stays HEURISTIC and its evidence says which grouping it depends on.
How the rule reads the names is in [the rule packs page](../rules.md).

`cascade analyze` prints how many declared routes the rule gave a handler, warns
`CONTRACT_NOT_LINKED` for a method it would not link, and prints no
`OPENAPI_NOT_SERVED` for a route it linked. `laneStats.openapi.contractLinks`
lists the links and the methods left unlinked; a pairing whose route the code
already maps to the same method is counted apart (`alreadyHandled`), never as a
link. The overview's `contract-links` gap counts the links that are guesses,
and its fix is to declare `openapi.generatesCode` while any rests on no
declaration. The drift census still counts those routes as declared and not
served, because no mapping in the source serves them. A walk at the default
`conservative` mode does not follow a HEURISTIC link; `mode=heuristic` does, and
so does every mode once the declaration makes the link EXACT.

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

What the second declaration MEANS depends on where it is written. A router
draws a parent and, in its outlet, the child whose path adds nothing, both at
the parent's own path: `{path: 'account', component: Shell, children: [{path:
'', component: Settings}]}` shows Shell and Settings together at `/account`. So
a declaration written under or above every declaration already drawing that
path (a child with the path `''`, a react-router index route, a ui-router state
with an empty `url`, a lazily loaded list whose first route is `''`, across
files too) joins the screen: its component renders there as well, and the node
lists every such file in `components`. These are counted as
`laneStats.web.screens.nestedSamePath`. Two declarations that are not on one
nesting chain (two `''` siblings, two unrelated routes) keep the rule above:
the first is the screen, the other renders nothing there, and they are counted
as `duplicatePaths`.

A route's parent in the same file is found by its place, line and column,
because `{ path: 'team', children: [{ path: '', component: T }] }` is two
routes on one line, and a parent found by its line alone was the child itself.

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

**A page that imports a route runs it inside its own request.**
`<c:import url="/sym/mms/EgovHeader.do"/>` is not a link: the container runs that
route while it renders this page and writes the output in place, and a
`<jsp:include page>` that names a route rather than a template is the same. So the
handler that renders the page gets `symbol --CALLS_HTTP--> endpoint` onto each
imported route, rule `template-import`, graded SOUND_SET by the route match, for
imports written in the page or in any template it includes. A page's links stay
off the walk, because they are the next request; an import is this one. Measured
on the eGovFrame enterprise business template: 70 pages import the header, the
footer and the left menu, 398 import edges in all, and a run of its list screens
read the menu tables on 20 of the 26 routes it exercised, which the pack did not
reach until this rule.

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
| `components` | every component file drawn at this path, when a nested route with a path that adds nothing draws one here too |
| `file` / `line` / `pack` | the declaration itself, and which router pack recognized it |
| `params` | true when the composed path has a `:x` or a `*` in it |
| `hidden` | present only when the declaration says so |
| `source` | `router`, or `har` for a page only a recording found |

### RENDERS: what a screen actually runs

`screen --RENDERS--> symbol` joins a screen to the frontend functions it can run.
Nothing about it is guessed from a name:

- **EXACT** onto every function of the file the route DECLARES as its component.
  The route says which file it is; the function is in that file. A component
  declared at the same path on the route's nesting chain (see above) is drawn
  the same way, with the rule `route-nested-component`.
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
| `SOUND_SET` | `this.orders.list()` through a field whose TYPE the class states (a constructor parameter property, or `orders = inject(OrderService)`), onto the method of the class that type names and of every class a provider puts behind it (rule `typed-field`). A provider is a `providers` entry, or `@Injectable({ providedIn: 'root', useClass: Mock })` on the type's own class, which puts a Mock behind it (`adapters/web/packs/injection.json`). A class that does not declare the method runs the one the nearest class up what it `extends` declares. Never EXACT: a provider may put another class in the type's place. HEURISTIC when the set may be short: a provider made by `useFactory` or `useValue`, one naming a class this lane did not read, or a class whose method this lane found nowhere up what it extends |
| `HEURISTIC` | an ASSUMED alias was on the path |

A call onto an imported name that is **not** a function (a constant, a
component) makes no edge and is counted as `calls.notAFunction`.

**A member of an imported object.** Most TypeScript frontends keep their API
calls in a named object rather than in loose exports:

```ts
export const contentService = {
  get: async (no: number) => axios.get(`${CONTENT_URL}/${no}`),
}
```

and the page writes `contentService.get(id)`. That is the same one hop, and it
is read as one. The key alone (`get`) cannot say which object it belongs to —
two objects in one file can both have a `get` — so the worker records the owner
beside the name (`member: "contentService.get"`) and the bridge looks the member
up by that. `.ts` and `.js` are alike here, an `export *` barrel between the two
files grades the edge SOUND_SET as it does for a bare call, and the edge carries
`evidence.member`. Only the DIRECT members of a named object are followed: one
level deeper (`a: { b() {} }`) there is no name a caller writes, and a member
call that lands on anything else — a client instance, a library object — is the
sink the HTTP pass already explained, so it is no edge and no miss.

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
component file (`.vue`, `.tsx`, `.jsx`, or a `.ts` file with a class Angular's
`@Component` marks) carries `component: true`, so a tool can tell a function in
a screen from an api function. A `.ts` or `.js` module that
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

These are the keys that shape screens. Every key a profile can hold, with an
example of each, is listed in [concepts.md](../concepts.md#9-the-profile-key-by-key);
the web lane also reads `gatewayRoutes` (above), `servers` (see *This machine,
another port*), `webRoots` and the `openapi` keys (see *OpenAPI documents*).

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
  | `null`, or the key absent | decide it from what the run READS: on when `frameworkPacks` names a router pack, when a frontend package this run really reads depends on `vue-router`, `react-router`, an AngularJS router or `@angular/router`, or when the run reads a template root at all; off otherwise. This is the default |

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
this lane could not resolve, when more than a fifth have a path it could not
compose (see *Routes named across files*), when `nameSource` asks for something not shipped, or
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
  source line says which component it mounts. A page a controller renders is
  matched by **every** route that renders it (`paths` on the screen node), so the
  edit form of a server-rendered app is one screen whether `/addView.do` or
  `/editView.do` opened it.
- A path parameter is not part of the route: a container that cannot set a
  cookie writes the session into the address (`/list.do;jsessionid=…`), and it is
  read as `/list.do`.
- **Which screen sent a request.** A request made inside a page (a `fetch`, an
  XHR) belongs to the page it was made on, which is what the HAR's `pageref`
  says. A request that OPENS a page (an HTML response or a redirect) does not:
  the HAR files it under the page it opens, and the page that sent it is the one
  its **Referer** names. A server-rendered app sends almost everything that way,
  as a link or a form submit, so there the Referer is the only place the sender is
  written down. A request a redirect sent (`302` then the `redirectURL`) and a
  page opened with no Referer (typed, bookmarked) are placed on no screen, and
  counted as `followedRedirects` and `openedByAddress`. Measured on the eGovFrame
  web sample, driven through both of its screens in a browser: seven
  screen-to-route pairs were observed, and every one is a `form-submit` edge the
  static analysis already had.

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
pagesWithoutScreen, sentByReferer, followedRedirects, openedByAddress, pairs,
screensObserved, endpointsObserved, unmatchedPaths}`.

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
  `.vue`, `.tsx` and `.jsx` as one, plus a `.ts` file whose class a pack's
  decorator marks (Angular's `@Component`).
- **No screen a route does not declare**, unless a recording found the page. A
  router filled in from the server contributes only the routes in the source, and
  the axis says so.
- **No `$ref` resolution in a document.** The routes and their `operationId` /
  `summary` are read; a `$ref` to a shared parameter or schema is left alone,
  because nothing here needs what it points at.
