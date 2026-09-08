# The viewer

`cascade view` starts one local web app over the same tool catalog the MCP
server uses. The page never reimplements a query. Every number on it arrives in
a contract-valid answer from the engine, so the page and a model
asking over MCP can never be told different things.

```bash
node bin/cascade.mjs view                      # every registered project
node bin/cascade.mjs view --project mall       # just this one
node bin/cascade.mjs view --pack .cascade/pack # one pack directly
# → http://127.0.0.1:4319/
```

## What you are looking at

The page has a masthead, eight tabs, and one rule that runs through all of them:
a glance is a number or a picture, a line of text is one sentence, and the full
paragraph is one click away and never opens itself.

### The masthead

The top line is the dateline: which project answered, its digest, which
analyzers ran, and the commit it was built from. Under it runs the chain this
engine follows, step by step, with a count on each step: api groups, endpoints,
services, SQL, tables, columns. The counts are the `overview` answer's own; the
page counts nothing itself.

Beside them are three chips.

- **freshness** says whether the pack still matches your working tree.
- **trust** is the computed trust level, never a typed-in one.
- **limits** is a count. Click it and every limit the engine wrote opens
  underneath, word for word. It is the same fold the evidence rail beside each
  answer carries, so the sentences appear once and in one voice.

Then the language toggle and the theme toggle, which are described below.

### Folds

Under every tab's toolbar is a one-line lead. Click the chevron and the
paragraph opens: what the tab is for, how to read the picture, and what the
engine could not prove. Nothing is deleted by a fold. Counts always stay
outside it, because a count is what a glance is for.

Each fold remembers whether you left it open, per fold, in `localStorage`. A
language switch rebuilds the block out of the catalogue and puts it back the way
you left it.

### Themes

Two themes on one set of tokens, and the toggle sits in the masthead.

- **Dark** is the signal room and the default. Every kind of node carries its
  own hue, and a lit one glows.
- **Light** is the engineering drawing: ink on paper, where the glyph carries
  the kind and the page still reads when printed in greyscale.

The choice is yours and is remembered (`cascade.viewer.theme`). We do not
consult `prefers-color-scheme`: the product has a default, and you override it,
rather than the operating system deciding what this page looks like.

## The tabs

### Overview

Four dials across the top, drawn from the `overview` answer's `reach`: how many
endpoints reach SQL, how many statements, tables and columns are reached. Under
each number is what it leaves out, in that step's own terms, because a share
only means something beside its remainder.

Beside the dials is the cartography: the live whole-project map at reduced
height, from the very `map` answer the Graph tab uses. It is asked once and
shared, so opening the Graph tab does not fetch it again. Hover a node to light
one chain, click to pin it, double-click to open it on the Graph tab.

Under the hero, one fold holds the cascade ribbon: one bar per step of the
chain, the dark part what an endpoint reaches and the striped part what nothing
reaches, with a band between bars showing how much carries over. Below that are
the panels: what is in the pack, edges by type and grade, the Java side, the hub
tables and endpoints, and what the engine could not see.

**Connected projects.** Where this project calls a route it does not serve, a
panel beside the blind spots lists who answers it: one row per registered
project, with the routes and how many methods here make each call, five routes
and then a count. Clicking a row goes to that project. A last row holds the
calls no registered project serves, with the one thing you can do about it,
which is to register the project that serves them. On a project that calls
nobody the panel is absent, because a panel saying zero about something this
pack does not do is noise.

### The browse rail

Explore, Flow and Impact open on a LIST, not on an empty search box: a column
down the left with the kinds that tab can show and their counts, a filter, a
sort, the count line, and the rows themselves with the numbers you would pick
by. Every row and every number is one `browse` answer, so the page counts
nothing; typing in the box filters the rows it already holds and sends no
request. Pressing Enter on an exact name still asks the server, as it always
did. `/` puts the cursor in the filter, the arrow keys move the highlight, Enter
picks. Under 1100px the rail becomes a drawer behind a **Browse** button, and a
pick or Escape closes it.

Flow buckets its endpoints under the API group each belongs to. Impact gives
every table a caret that opens it into its own columns, one request per table,
so you can walk from a table down to the column you are about to change. Before
you pick anything, the right-hand side carries one sentence and the five busiest
rows off the list already loaded.

A statement and a method read by their short name in the rail
(`PmsProductDao.getUpdateInfo`, `OmsPortalOrderController#generateOrder`), which
is the same name the chain lanes and the graph cards use: at 320px a fully
qualified name spends the whole row on a package prefix every row shares, and
the ellipsis then eats the part that tells them apart. The full id is in the
row's tooltip, and it is still what the filter matches, so typing a package name
finds its rows.

### The source pane

The picture is the claim; the source is the evidence. One pane shows it, docked
to the right edge under the masthead, and every part of the page that used to
draw its own little code box now opens this one: an Explore statement or method
row, the **Source** button on a Flow or Impact row card, the same button on the
graph's node cards, and the Transactions boundary. It reads the file on disk
through `GET /api/source`, so it shows what is there right now, not a copy baked
into the pack.

It carries the file's own line numbers, marks the lines the answer is about with
a bar and a tint, and scrolls to them with three lines of context above. The
header names the node, the path and line (click it to copy `path:line`), the
language, and the range. **snippet** shows the method or statement on its own and
**whole file** fetches the file around it, keeping the same lines marked; `f`
does the same from the keyboard, `j`/`k` and the arrow keys scroll a line, and
Escape closes. **Open in editor** opens the file at that line in the editor the
select beside it names, through `vscode://file/<path>:<line>:1` or
`idea://open?file=<path>&line=<line>`; with `none` the button copies the absolute
path instead. Drag the pane's left edge to resize it, from 420px to 90% of the
window; the width and the editor are remembered.

There is no backdrop, on purpose: the pane behaves like an IDE preview. It opens
only when you ask for it, and from then on it follows every row you pick, in
place, while you go on clicking underneath it. Once you close it, it stays
closed until you ask again.

### Getting back to the whole

Every tab that can narrow carries a **Show all** at the right end of its
toolbar, and it is greyed out while the tab already is its opening state, so the
button also tells you whether anything is narrowed. Pressing it clears the
filter and the selection, puts the rail back on the kind the tab opened with,
brings the quick-picks card back, clears the picture on Flow and Impact, folds
the Graph map and fits it, drops the ERD highlight, and closes the source pane.

Escape does the same from anywhere in the tab. When the cursor is in a box it
takes two presses: the first empties the box, the second puts the tab back.
Clicking the name of the tab you are already on resets it too.

### Explore

Pick a table, column, statement, endpoint or method from the rail, or search one
by part of its name. A column shows the SQL statements that read or write it and
the HTTP endpoints above those statements, each with its grade. **My edits** asks
the same question about your uncommitted git changes.

### Flow and Impact

Flow reads one API call left to right: the endpoint, the service methods it may
run through, the mapper statements those reach, and the tables at the end.
Impact is the same machinery run backwards from a column, table, statement or
method, up to the endpoints that can reach it.

A solid connector is a call the engine can prove; a dashed one is a call it
thinks happens but could not confirm. Small dots ride each connector in the
direction the walk actually ran, left to right on Flow and right to left on
Impact. They are SVG motion along the path, not a frame loop, so they cost
nothing when the tab is hidden. A reader who has asked their system for less
motion gets a static arrowhead instead, and no animation at all.

Two views share the toolbar: **chain** draws the whole path left to right, and
**by hop** groups the same rows one step at a time, with a census per hop.

### Coupling

Two API groups can depend on each other without ever calling each other: one
writes a column, the other reads it. The matrix shows those pairs, writer down
the side and reader across the top. Click a cell for the columns or tables the
two share, and the statements that carry them.

### Graph

The Graph tab opens on the whole-project map. At rest it draws API groups and
tables only, with each group-to-table line standing for every endpoint in that
group that touches the table. Click a group and its endpoints unfold as
satellites around it; the count line says how many are still folded. Find
unfolds the group of whatever it found.

Three rules keep it readable. A node's radius follows the square root of its
degree, so a one-line table stays visible and a hub is unmistakable. Labels go
on the busiest nodes, on every group, and on whatever is lit, with all of them
once you zoom past 1.6×. Lines are quiet until a chain is lit.

Line colour is what the endpoint does to the table, blue for reads and red for
writes or deletes; thickness is how many statements carry it; a dashed line in
2D is a chain we could not confirm. A chip hides a whole kind and keeps its
count; the statements chip re-asks the engine for the SQL layer, because without
that layer the engine sent no statement at all.

**Where a request leaves this project**, the map keeps going. An endpoint that
calls a route another registered project serves gets a line to that project's
own route node, and under it what that route reaches over there. Those nodes
keep their kind's fill, so a table still reads as a table, and wear a ring in
their project's own hue with the project name in the label; one node per
connected project is the skeleton its routes hang off. Each cluster seeds on its
own band to the right, so the picture reads as "our map, and over there what it
calls" rather than two systems shuffled together. Nothing is merged: only what
this project's requests reach is drawn, and no line joins two projects' tables.
A chip turns the whole layer off, and the count line still says how much came
from elsewhere. Clicking one of those nodes gives you one action, which is to
open it in the project that owns it, because every other button would ask the
pack on screen for something it does not have.

The map does not move at rest. A dot on every line of a map this size is
speckle, so the lines stay still until you point at something: a node you light
flows on its own, and **Flow on** runs every line. Past 2500 directed links even
that stays limited to the lit chain, and the toolbar says so.

Double-click a node for **Around \<node\>**: that node in the middle, what
touches it on ring 1, what touches those on ring 2. Columns start hidden when
the middle is a table or a statement, because they would otherwise be most of
the picture.

### ERD

The whole schema, laid out by the joins the mapper SQL makes between tables. We
do not read foreign keys, so a relationship here is a join some statement makes.
A table's size follows its relationship count on the same square-root rule as
the map, and its label scales with it. A thicker line means more statements make
that join. In the dark theme, tables sharing a name prefix take a desaturated
tint of their kind's hue and the legend keys it; the light theme stays ink.
Tables no SQL joins to anything sit in a strip under the map, named as such
rather than dropped.

**A connected project is its own framed cluster**, off to the right, holding
only the tables a request from here reaches and only that project's own joins
between them. From a small route marker a **dashed** line runs to each table
that route reaches, and the legend says what the dash means: reached over an
HTTP call, not a foreign key. No relationship on the sheet ever joins two
projects, because two services share no foreign key. The switch in the legend
starts ON where this project has no table of its own, since the sheet would
otherwise be empty and the requests really do end somewhere, and OFF where it
has a schema of its own; either way it is remembered. Clicking a table over
there shows that project's own relationships and asks that project for its
columns, never the pack on screen.

### Transactions

Every `@Transactional` method, and what one commit can touch through it.

## One server, many projects

The server serves every project in `~/.cascade/registry.json` unless you narrow
it. **The page shows one project at a time**, because an answer that does not
say which pack it came from is worse than no answer.

- **The header carries the selector.** More than one project served: a
  `<select>`. Exactly one: a static label, because there is no choice to offer.
  None at all: a line saying so, naming `cascade init` and `cascade analyze`.
- **Selecting a project is not a filter.** It is a different pack, so everything
  on screen is wrong until it is asked again. Every tab's cached answer is
  dropped, the Graph, `Around <node>` and ERD renderers are torn down, the Graph
  tab goes back to the whole-project map, and the Overview is re-asked. Nothing
  is reused across projects.
- **An answer for the project you have left is dropped, not drawn.** Every call
  is tagged with the project and a sequence number it was made for, and a reply
  that arrives after the selection changed is discarded silently. Opening a deep
  link into another project can therefore never flash this project's answer.
- The registry listing (`GET /api/projects`) is **lazy**: it reads the registry
  and nothing else. A project's `meta`, meaning digest, build time, lanes, axes
  and freshness, is `null` until that project has actually answered something.
  `null` there means "not loaded", never "this pack has nothing to say".

### The URL

The page writes what it is showing into the hash:

```
http://127.0.0.1:4319/#p=<project>&tab=<overview|explore|flow|impact|coupling|graph|erd|tx>
                       [&pick=<kind>:<id>][&src=<kind>:<id>]
```

Reloading lands on the same project, the same tab, the same pick and the same
source pane, and you can send the link to somebody else. A pick pushes a history
entry, so the browser's Back button walks back through the pictures you drew one
at a time; an answer still in memory is drawn again without asking the server for
it. A tab or a project change replaces the entry instead, because neither is a
step you want to undo one at a time. On load the project is taken from, in order: the hash, the
`?project=` query the CLI prints at start-up, then what this browser chose last
time (`localStorage`). A project the server does not serve is ignored rather
than sent, so you get the first served project instead of an error.

### Errors

An unknown project is a `404` and an unnamed one on a multi-project server is a
`409`, both as JSON. The page renders them as a **banner in the pane that
asked**, never a blank panel. The message is the engine's own sentence, word for
word.

## Language

A toggle in the masthead switches the interface language. English is the
default, and the choice is remembered in `localStorage`. Switching re-renders
the chrome and **asks the server for nothing**: the answers already on screen do
not move, because the engine's words do not change with your interface language.

### What is translated, and what is not

Translated: the **chrome**, meaning every word the *page* wrote for itself.

- tab names, header labels, the project selector, the language toggle
- buttons, toggles, select options, input placeholders, tooltips
- the lead and the paragraph under each tab's fold
- loading lines, empty states and the frame around an error banner

Not translated: everything the *engine* said.

- edge grades (`EXACT`, `SOUND_SET`, `HEURISTIC`, `RUNTIME_ONLY`, `UNRESOLVED`)
- trust levels and trust axes, freshness verdicts
- `limits`, truncation notes, `empty` reasons (`not-shipped`, `not-in-this-axis`)
- every tool's error message, node id, column name, SQL text and comment

That split is the honesty contract. A translated grade is a grade
this project invented: no reader could check it against the engine's own answer,
and no two viewers would agree on what it meant. The engine's words are
evidence, and evidence is quoted rather than paraphrased. Where the page has to
name one of those words, it says once in plain language what it means and then
uses it.

### Where the strings live

- `src/viewer/i18n.mjs` holds the lookup (`makeT`, `interpolate`, `richText`)
  and the **English** catalogue, `VIEWER_STRINGS.en`. The page carries a
  verbatim copy of that block, because it is one self-contained file and cannot
  import from `src/`. `test/i18n.test.mjs` fails if the two drift.
- `viewer/i18n/<lang>.json` is one file per other language, served by
  `GET /i18n/<lang>.json` from an allowlisted directory, like `/vendor`: only
  `.json`, only out of that directory, and every escape a 404.

The translations are files rather than page content on purpose. The English-only
gate (`test/gates.test.mjs`) scans `src`, `bin`, `adapters`, `scripts` and
`viewer/index.html` for non-English text, and `viewer/i18n` is the single
excluded path, the one place non-English text is expected.

`t(key, params)` never throws. A key the chosen language lacks falls back to
English; a key no catalogue has renders as the key itself and is recorded in
`t.missing`, so a hole is visible on the page and countable in a test rather
than silently blank.

### The voice these strings are written in

Every sentence on this page is one experienced developer explaining a screen to
a colleague who knows Spring and SQL but has never seen this tool. In practice
that means: say what a thing is for before what it is, use the reader's nouns
(API, controller, service, mapper, SQL, table, column), one idea per sentence,
and a number stated as a fact. `test/i18n_voice.test.mjs` holds the part a
machine can check: no em dash and no middle dot in a catalogue string, a lead of
at most 90 characters, a paragraph of at most four sentences, and every Korean
sentence in the polite 합니다체 rather than the flat note-taking register.

### Adding a language

1. Copy `viewer/i18n/ko.json` to `viewer/i18n/<lang>.json` and translate the
   values. Keep every `{placeholder}`: `test/i18n.test.mjs` checks that a
   translation did not drop one, because `{message}` is where the engine's own
   sentence goes.
2. Give the file its own name in `lang.label`, since the toggle shows each
   language in its own language.
3. Add the code to `LANGS` in `viewer/index.html`.

The key set is enforced. A translation must carry exactly the English keys: no
fewer, so nothing silently falls back, and no more, so a stale key cannot
linger.

## Where to read next

[concepts.md](concepts.md) explains the grades, the partial packs and what an
empty answer means. [mcp.md](mcp.md) is the same question surface, for a model
instead of a person.
