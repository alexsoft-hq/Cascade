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

The page has a masthead, five places, and one rule that runs through all of
them: a glance is a number or a picture, a line of text is one sentence, and the
full paragraph is one click away and never opens itself.

Each place is a question a reader comes with:

| Place | What it answers |
|---|---|
| **Start** | Where do I begin? Find any target and ask what breaks if it changes, how far it reaches, or what the analysis did not see. The map of the whole pack is here too. |
| **Trace** | One target, read either way: what it uses, where it is used, and what it is. |
| **Structure** | The whole pack as drawings: Graph, Table links (by SQL joins), Coupling and Transactions. |
| **Compare** | What changed since an earlier build of this project. It appears only when there is one. |
| **Analysis status** | What this analysis could and could not see, what each gap touches and what to do about it, and the Rules it ran with. |

A place that holds more than one view (Structure, Analysis status) shows a
second row under the first, one entry per view. Opening a place lands on the
view you were last on there. Clicking the place you are already on puts a view
that can narrow back to how it opened, as **Show all** does.

The tab bar used to hold ten things of three different sorts: questions
(Explore, Flow, Impact), drawings (Graph, ERD, Coupling) and the analysis's own
state (Rules). A reader had to know which tab held which half of a question
before asking. The places sort them by what a reader wants to know. Every link
written before still lands where it did ([The URL](#the-url)).

### The masthead

The top line is the dateline: which project answered (the project selector when
the server holds several), and which lanes built its pack. **build** beside them
opens the pack's digest and the commit it was built from. They stay one click
away because a reader needs them when two builds disagree, and has to look past
them every other day.

Under it runs the chain this engine follows, step by step, with a count on each
step: screens, api groups, endpoints, services, SQL, tables, columns. The counts
are the `overview` answer's own; the page counts nothing itself.

- **api groups** is `reach.groups`, counted by the rule the map groups routes by,
  so it is right whichever place a page opens on.
- **services** is `code.services`: the methods the routes' walks pass through
  between a controller and the SQL, each counted once. A controller method, a
  frontend function, a library method and a mapper method that only declares a
  statement are not counted.
- A count marked `~` comes from an axis that is not whole, and its hover gives
  the engine's reason: a pack with no schema still has the tables its SQL named.
  An axis that was never built reads **not collected** and opens the row on
  Analysis status that says why.

Beside them are up to four chips.

- **freshness** says whether the pack still matches your working tree.
- **trust** is the computed trust level, never a typed-in one, and it appears
  only when there is something to say. A project with no approved golden set gets
  **no chip at all**: `not certified` was true of nearly every project anybody
  has ever opened, and a reader could do nothing about it from the masthead. The
  level still stands on Analysis status and in the evidence rail beside every
  answer, and its hover there names the two things that move it (approve a
  golden set, or label the checks from a recording of the program with
  `cascade golden propose --from-otel`). A level that rests on a run reads
  `checked against what ran`, in amber, and its hover says what a run cannot
  cover.
- **trace** appears only when a recording of the program running was read into
  the pack. It names the recording's source and how many spans it held.
- **limits** is a count. Click it and every limit the engine wrote opens
  underneath, word for word. It is the same fold the evidence rail on Analysis
  status carries, so the sentences appear once and in one voice.

Then the language toggle and the theme toggle, which are described below.

### Folds

Under every view's toolbar is a one-line lead. Click the chevron and the
paragraph opens: what the view is for, how to read the picture, and what the
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

## Start

Start asks first. It used to be the Overview, which opened on the shares and a
drawing of the whole pack before you had said what you came for.

**Ask about one thing.** The box finds any API route, screen, table, column, SQL
statement or method, with the same typeahead Trace uses, and says the kind of
each row. `/` puts the cursor in it from anywhere on Start. Pick a target, then
one of three questions:

- **What breaks if I change it?** opens Trace on the target, walked up: the SQL,
  the code, the APIs and the screens that reach it.
- **How far does it reach?** opens Trace on the target, walked down: the code it
  runs through and the tables at the end.
- **What did the analysis not see?** opens Analysis status. Its line says how
  many things the analysis could not see and how many of them can change an
  answer.

A question the target has no answer to stays on the page and says why in one
sentence, the one Trace uses: a table is where a chain ends, so it uses nothing;
a screen is the top of the chain, so nothing uses it. It is not a greyed-out
button. With no target picked, the first two questions open Trace's list on the
kind they most often start from (tables for "what breaks", APIs for "how far"),
already reading that way, and the list's lead says which question is waiting.

**What this analysis can see.** The lanes that read the project, the mode and
depth the census was walked in (and so which grades it followed), and one chip
per axis: collected, only partly read or not collected, and, for the schema,
where it was read from (the DDL file, or the mapping that declared the tables).
The two Java bridges (JPA, MyBatis-Plus) are listed only where they ran, because
on another stack "not collected" is noise. A chip opens that axis's row on
Analysis status.

**Gaps that change an answer.** An input the run did not have, something it
could not read, an axis read in part, a kind of diagnostic a lane reported: each
changes what an answer says, so they are listed here, inputs first, six and then
a count, each a way to its row on Analysis status. A walk's own bound or a table
no route reaches changes no answer and is left to Analysis status. When some
routes' own addresses rest on a guess, that is the first line, and it says
whether the mode on screen stops at them.

**The shares.** One card per step of the chain, from the `overview` answer's
`reach`: how many endpoints reach SQL, how many statements, tables and columns
are reached, and how many screens reach a table. Under each number is what it
leaves out, in that step's own terms, because a share only means something
beside its remainder. And under that is the one limit the share has to be read
with, in the same card: the step's axis when it was not built or only partly
read ("no database schema was read: these are the tables the SQL named"), and
on the endpoints, how many routes' own addresses are guesses. The limit is a
button to the row that explains it. "tables reached 100%" on a project whose
schema was never read would otherwise read as "the whole database".

On a project whose requests are answered somewhere else, the remainder is the
wrong sentence: a gateway's nine screens reach no table it owns, because it owns
none, and eight of them end at a real column one HTTP hop away. Where the answer
carries `reach.viaFederation`, the endpoint and screen cards say both numbers
instead: `0 here, 8 in connected projects`. The share itself stays this
project's own ratio, because that is what a share of this project means.

Under the shares is the map, and under the map the busiest tables (by how many
APIs reach them), APIs (by how many tables they touch) and screens (by how many
tables they reach). A table opens Trace walked up; an API or a screen, walked
down.

### The map

The map is the whole pack in about ten boxes a side: groups of routes on the
left, families of tables on the right, and one line per group and family, as
thick as the tables behind it and dashed by the weakest grade on the way. It is
the `summary` tool's answer, asked once Start is on screen, so a page opened
straight on Trace never waits for it. Boxes past ten are folded into one
`(others)` box on each side, and their lines go to it, so nothing the walk
reached is left off.

- **A box opens in place.** Click a group and its routes list under its name,
  twenty and then all of them; click a family and its tables do. The picture
  keeps only the lines through that box, and the boxes none of them reach step
  back.
- **A route or a table shows only its own paths.** Pick one inside an open box
  and the map asks `summary` for the paths through that node (`answer.through`):
  a route's lines run from its row to each family it reaches, a table's from
  each group whose routes reach it to its row, each dashed by its own weakest
  grade. Beside the picture are the ways into Trace from it (what it uses, where
  it is used, details) and the paths as lists, each member a way into Trace.
- **A breadcrumb goes back** a step at a time: the whole map, the open box, the
  picked node.
- Every route and table in an open box has a **Trace** button beside it: a route
  walked down, a table walked up.
- The mode select over the map asks the walk again in another mode. A map with
  no line says why in its own numbers: how many links the mode left out and of
  which grades, with the wider mode that would walk them. On a pack whose
  routes' own addresses are guesses (ghostfolio's, until its exclude list is
  declared), a conservative map has no line, and that is the first thing it
  says.

**The boxes are read, not declared**, and the line over the picture says which
rule made them:

- a group is the handler's package cut to `moduleAttribution.packageDepth`
  segments when the profile declares it;
- otherwise it is where the handler code sits, read below every package level
  that one branch holds four in five of the routes of (`egovframework.com` in
  eGovFrame, `org.jeecg.modules` in jeecg-boot), with a stray branch beside it
  as a box of its own;
- when every handler sits in one package, or there is no handler, it is the
  route path, read the same way (`/api/mdm/...` under a shared `/api` is `mdm`).
  Where every route's lane wrote the group its deployment prefix leaves (a
  NestJS global prefix and version), that is the group, and nothing is guessed;
- a table family is the tables whose names start with the same word below a
  shared prefix (`t_ds_task` under `t_ds`). A word ends at an underscore, a
  hyphen or a change of case, so `SymbolProfile` is symbol, profile and
  `MARKET_QUOTE` is market, quote. Only where most names are one word and most
  of them start with the same letters is a family read by its letters
  (eGovFrame's `COMTN...`, `COMTH...`);
- a table a rule names as one a framework made only to join two others (Prisma's
  `_OrderToTag`, the `table.join-table` rule `prisma.relation-tables`) is not
  read by its name. It goes with the tables it joins when they sit in one
  family, and into `(join tables)` when they do not.

These are patterns in the code and the schema, not modules anybody declared, and
the `summary` tool's limits say so beside the map. When one box still holds most
of the routes, a limit says that too.

## Trace

Trace is one place to ask about one thing: an API route, a screen, a table, a
column, a SQL statement or a method. Pick it once, then read it one of three
ways.

- **What it uses** follows it down: the code a route or a screen runs through,
  the SQL that code sends and the tables at the end.
- **Where it is used** follows it up: the SQL, the methods, the routes and the
  screens that reach it, which is what a change here would touch. Up from a
  route it is the frontend functions that call the route and the screens that
  render them.
- **Details** says what the thing is, as lists (below).

A kind of target offers only the directions it has:

| Target | What it uses | Where it is used | Details |
|---|---|---|---|
| API route | yes | yes | yes |
| screen | yes | no: a screen is the top of the chain, and nothing calls it | yes |
| method | yes | yes | yes |
| SQL statement | no: it uses only its own tables, which are under Details | yes | yes |
| table | no: a table is where a chain ends | yes | yes |
| column | no: a column is where a chain ends | yes | yes |

A direction a target does not have is not a greyed-out button. It is absent,
and the line over the answer says why in one sentence. The table is the `flow`
tool's own (`FLOW_DIRECTIONS`, [mcp.md](mcp.md)), and a test holds the page to
it.

Explore, Flow and Impact used to be three tabs over this one question, and each
kept its own pick, so switching between them lost the target. A link written for
one of them still opens here ([The URL](#the-url)).

### The list

Trace opens on a LIST, not on an empty search box: a column down the left with
the kinds you can pick and their counts, a sort, the count line, and the rows
themselves with the numbers you would pick by. Routes and screens sit under
their API group, and a table has a caret that opens it into its own columns, so
you can walk from a table down to the column you are about to change. Every row
and every number is one `browse` answer, so the page counts nothing. The kind
the list opens on is remembered per project, because which end of the chain a
reader starts from is a fact about the project.

The box over the picture does two things. Typing filters the rows the list
already holds and sends no request. It is also a search over every kind (routes,
screens, tables, columns, statements and methods), and each row of its dropdown
says which kind it is. `/` puts the cursor in the filter, the arrow keys move
the highlight, Enter picks. Under 1100px the list becomes a drawer behind a
**Browse** button, and a pick or Escape closes it.

The list's right edge can be dragged wider, and the width is remembered. A name
too long for it gives up its middle, never its tail: a route keeps its verb and
its last segments, a CamelCase name its last words. A statement and a method
read by their short name (`PmsProductDao.getUpdateInfo`,
`OmsPortalOrderController#generateOrder`), the same name the lanes and the
graph cards use. The full id is in the row's tooltip, and it is still what the
filter matches, so typing a package name finds its rows.

### The start, and the row you click

The target is the start of the question. A row you click in the picture is only
looked at: its card shows its path, its grade and its source, and the question
on screen does not move. **Trace from here** on the card starts the question
again from that row, read the same way when its kind can be. Switching the
direction keeps the start.

### Three settings with three names

- The **mode** says which grades a walk follows. Each mode is named by what it
  admits, with the grade it adds after it: strict, proven links only (EXACT);
  conservative, proven links and candidate sets (SOUND_SET); heuristic, proven
  links, candidate sets and guesses (HEURISTIC). The middle one used to be
  called "likely calls", which said nothing about which links it follows.
- The **depth** is the most links a walk follows from the target. It is **all**
  by default: every walk has no hop cap, and a node cap of 4000 guards the
  pathological graph ([concepts.md](concepts.md)). A number from 1 to 8 narrows
  it. A depth you chose stays when you switch direction or pick another target.
- The **rows per lane**: a lane shows 40 rows at first. Its heading keeps drawn,
  fetched and total apart, and **fetch N more** asks the tool for the lane's next
  rows in the walk's own order (`flow` pages a lane with `offset`).

Depth, the drawing and the motion sit under **Options**; the mode stays on the
toolbar.

### The picture

The chain is drawn as lanes, one per step, from the target outwards, left to
right. Each lane names every node in it, in the words a developer uses:

- a method is `Class.method`, a MyBatis statement `Mapper.id`, an ORM call site
  `Service.method #n`, a web function `module.function` (an index file is its
  folder), a column `table.column`;
- a route keeps its verb and the segments that tell it apart, and gives up its
  middle;
- two nodes that would read the same get more of what tells them apart
  (package, file, folders).

A lane is as wide as its names need, from 200 to 360px. A name takes at most two
lines and loses its middle, never its tail, and the hop and the grade sit on the
line under it. Rows are ordered to cut crossings inside their hop and grade,
never across a candidate band: on mall, Impact of `pms_product` went from 200
crossings between lanes to 22. A lane of more than 14 rows folds one owner's
rows at one hop and grade into one row, and the rest into "N more", both opened
in place. The picked chain and what the find box found are never folded.

A line is dashed by the grade of that one link, and the badge on a row is the
grade of its whole path, which is the weakest link from the start. Solid is
EXACT, dashed SOUND_SET, dash-dot HEURISTIC, the same marks in the SVG a file
saves. A candidate band says what it is: "candidate set (n): the real target is
among these"; "guessed (n): check these". A lane the walk found nothing in is
drawn after every lane that has rows, so no line runs behind an empty lane.

Over the picture a strip that does not scroll away names the start and every
lane with its count, jumps to a lane, and finds a row by name or id. A picked
chain stays lit when the pointer leaves it, and the arrow keys move between rows
and lanes.

Small dots ride each line in the direction the call runs: left to right on a
walk down, right to left on a walk up, where the same call is drawn backwards.
They are SVG motion along the path, not a frame loop, so they cost nothing when
the view is hidden.
**Flow on** under Options stops them. A reader who has asked their system for
less motion gets a static arrowhead instead, and no animation at all.

Two views share the toolbar: **chain** draws the whole path, and **by hop**
groups the same rows one step at a time, with a census per hop.

### Beside the answer

Before the legend and the evidence rail, a panel says **what limited this
answer**, each line with its count from the answer: how many rows stopped at a
depth you asked for (with **Follow it all the way**), the node cap, the steps
inside generated code the profile skips, rows named just past the depth cap, every
lane shown in part (`shown of total`), and a pack with no frontend, where which
screens call a route is unknown rather than none. When nothing cut the answer,
it says that.

**What this walk left out** is its own panel, shown when the mode floor left
links out. It lists each grade it left out with its count and what that grade
means, offers the wider mode that would walk them, or says no mode walks them
(a link decided at run time, or one the analysis could not tell). When a route's
own link to its handler is below the floor, it says first that the walk stopped
at the route. Under that are the analysis's diagnostics, one row per kind with
its count, as on Analysis status.

### Details

Details says what the target is, as lists. Every list is one tool answer.

- A **table**: the SQL that reads or writes it, and its columns with how many
  statements read and write each (`table_usage`).
- A **column**: its statements with `read` or `write` on every row
  (`column_impact`), and the routes above them in the mode on screen
  (`endpoint_impact`).
- A **screen**: its functions, the routes they call and the tables those reach.
- A **route**, a **method** or a **statement**: a card with where it is, how
  sure its own link is and what it touches. For a route or a method, the
  `@Transactional` methods its walk down runs through, each a way into the
  Transactions view.

Under the card of a column, a table, a statement or a method stand the screens
a change there is felt on (`screen_impact`), followed all the way up in the mode
on screen, whatever depth the picture was asked at. Each is a way into Trace,
walked down.

**My edits** asks the same questions about your uncommitted git changes: what
they touch below and the endpoints and screens above.

### Exporting one answer

**Save as** on the Trace toolbar holds **Export**, **SVG** and **PNG**. Export
saves the picture on screen as one HTML file, for a report, a design review or a
message to someone who has no Cascade. A walk down is a Flow file and a walk up
an Impact file, the two names `cascade export --tab` takes; `cascade export`
writes the same file from the shell ([cli.md](cli.md#cascade-export)). Details
and My edits are lists, not a picture, so there is nothing to save there.

The file is this page with the answer inside: the markup, the stylesheet, the
scripts, the fonts, the chosen language, and the tool answers the picture was
drawn from, exactly as the server returned them. So it opens in any browser with
no server and no network, and it is drawn by the same code that draws the live
page. Nothing is re-rendered for export, which is what keeps a HEURISTIC line
marked and a cut list marked as cut.

A band under the masthead says what the file is before anything else does: the
one question it answers (picture, entry, mode, depth, row limit), when it was
exported and from which pack, and this answer's trust level with how many limits
and cut lists it carries. The evidence rail beside the picture names each of
them, as on the live page. The file opens in the light theme; the theme toggle
still works.

A file answers only the question it was exported with. The controls that would
ask a different one (the entry, mode and depth) are switched off, the list and
the other places are not there, and anything else that would reach the server,
the source pane included, says it is not in the file rather than guessing.
**chain** and **by hop** still work, because they are two drawings of the same
answer. Names that the live page cuts wrap in the file, because a printed page
has no pointer to hover them with.

**SVG** and **PNG** save the same answer as one picture for a slide or a
document. The server draws the SVG from the answer, with the same names, widths,
order and folds as the live lanes: one row per node with its grade badge, one
connector per link with its grade's dash, a cut lane's count of the rows it left
out, the question and the trust line above, and every limit word for word below.
A link whose source row is in a cut list is not drawn, and the picture says how
many. The PNG is that SVG drawn by your browser, at twice its size, so nothing
has to be installed. `cascade export --format svg` writes the SVG from the
shell.

## The source pane

The picture is the claim; the source is the evidence. One pane shows it, docked
to the right edge under the masthead, and every part of the page that used to
draw its own little code box now opens this one: a row's card on Trace, the
**Source** button on a Details card, the same button on the graph's node cards,
a statement in Coupling, and the Transactions boundary. It reads the file on
disk through `GET /api/source`, so it shows what is there right now, not a copy
baked into the pack.

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

## Getting back to the whole

Trace, Graph and Table links can narrow, and each carries a **Show all** at the
right end of its toolbar. It is greyed out while the view already is its opening
state, so the button also tells you whether anything is narrowed. Pressing it
clears the filter and the target, puts Trace's list back on the tables and
clears its picture, folds the Graph map and fits it, drops the table highlight,
and closes the source pane.

Escape does the same from anywhere in the view. When the cursor is in a box it
takes two presses: the first empties the box, the second puts the view back.
Clicking the place you are already on, or the view on its second row, resets it
too.

## Structure

The pack as drawings, one view each. The second row switches between them, and
a link to `tab=graph`, `tab=erd`, `tab=coupling` or `tab=tx` opens that view.

### Graph

The Graph view opens on the whole-project map. At rest it draws API groups and
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
that layer the engine sent no statement at all. A node's card has a button into
Trace for each direction its kind has.

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

**The advanced view.** 3D and the moving dots along the lines sit behind one
switch, **Advanced view**, off by default and remembered
(`cascade.viewer.graph.advanced`). Off, the map is the flat 2D canvas whatever
2D/3D last said, and nothing on it moves, a lit chain included. The answer is
the same either way; only the drawing changes. On, the 2D/3D switch and
**Flow on** come back to the toolbar: the resting map is still until Flow on is
pressed, a node you light flows on its own, and past 2500 directed links only
the lit chain moves, as the toolbar says. A reader who asked their system for
less motion gets no motion either way. The dots on Trace's lanes are not this
switch's; Trace's Options keeps its own.

Double-click a node for **Around \<node\>**: that node in the middle, what
touches it on ring 1, what touches those on ring 2. Columns start hidden when
the middle is a table or a statement, because they would otherwise be most of
the picture.

### Table links, by SQL joins

The whole schema, laid out by the joins the mapper SQL makes between tables. It
used to be called the ERD. It is named for what it draws, because we do not read
foreign keys: a relationship here is a join some statement makes. A table's size
follows its relationship count on the same square-root rule as the map, and its
label scales with it. A thicker line means more statements make that join. In
the dark theme, tables sharing a name prefix take a desaturated tint of their
kind's hue and the legend keys it; the light theme stays ink. Tables no SQL
joins to anything sit in a strip under the map, named as such rather than
dropped. A table opens its Details on Trace, and its card has a way to walk it
up.

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

### Coupling

Two API groups can depend on each other without ever calling each other: one
writes a column, the other reads it. The matrix shows those pairs, writer down
the side and reader across the top. Click a cell for the columns or tables the
two share, and the statements that carry them. A statement opens on Trace with
its source, and a shared column or table opens walked up.

### Transactions

Every `@Transactional` method, and what one commit can touch through it. A
route's or a method's Details on Trace list the transactions its walk runs
through, each a way into this view, and a boundary here has a way back into
Trace in both directions.

## Compare

The place compares the pack on screen with an earlier build of the SAME
project, and appears only when the project has one: every certified `analyze`
keeps the pack it replaces in `.cascade/history/`, the five most recent. Pick a
build by its commit and build time; the place asks `pack_diff` with it as the
base ([cli.md](cli.md#cascade-diff) has what is compared). It never offers
another project, because two codebases differ in everything. For a commit the
history does not hold, `cascade diff --base-commit <rev>` builds the base from
the repository.

What the place draws is one report, read from the top. The title names the
project, the base and the head (commit, build time, pack digest, and whether the
build held uncommitted changes). Then the conditions: whether the two packs were
analyzed the same way, and every condition that differs or is not recorded. Read
them before any count: a difference is a code change only when the analysis did
not change. A panel headed "Read before the counts" follows when there is
something to read first: every limit the engine states, every list cut at the
limit the page asks for (200 rows; the totals in the headings are always whole),
and, against a server older than this page, that node attributes and edge
evidence were not compared at all. Then the summary, in four groups: content
(nodes added, removed, or with a changed attribute), relationships (edges added
or removed), evidence (edges whose grade changed, or whose evidence reads
differently), and source location only (nodes and edges that moved in the
source and mean the same). The by-kind and by-type lines under it use the
legend printed with them.

Next come the endpoints and the screens above the change, read from both packs:
above what was added in the head, above what was removed in the base, and above
what changed or was regraded in either. A move in the source adds nothing here.
An end the head still has carries a button into Trace, walked down; one the
earlier build alone had is marked "earlier build only" and opens nothing,
because there is no chain to walk in the pack on screen. "What to check" is a
numbered list drawn from the counts and the flags alone: which panel to read
first, how many ends to open, how many attribute and evidence records to read
value by value. It carries no score and no verdict.

Then the records. Changed attributes and changed evidence are shown per field,
the value before and the value after, as text and never as markup: a string is
quoted, so `"null"` and `null` read as what they are, a value the other pack does
not record is said to be "(not recorded)", and a long value or one with a line
break sits behind a fold. Every attribute is compared except the source location
(file, line, declaration position). Then the edges whose grade changed, the
nodes and edges added and removed (a removed node whose axis changed between the
packs says so), and last the moves: nodes and edges whose file or line differs
and nothing else, listed apart with their own explanation so a file diff is not
mistaken for a graph change. A filter box above the report hides the rows that
do not carry the text typed; the totals do not change. When there is nothing to
list the report says which of these it is: the same pack, the same graph, a move
in the source only, or an older server that compared ids and grades alone.

Two buttons sit under the title. Print opens every fold and prints the report
with the masthead, the places and the controls left out, in ink on paper
whichever theme the screen had; the evidence rail with the trust level, the
limits and the cut lists prints after the report. Save as Markdown writes the
same report, from the answer already on screen and from nothing else, as a file
named `cascade-compare-<project>-<base commit>-<head commit>.md`: the base and
head with their whole commit, build time and digest, the trust level, the
conditions, the limits, the summary, the ends, the guidance, every list, and a
"Rows not shown" section naming each list the file holds in part. Every value in
the file sits in a code span or a fenced block one backtick longer than any run
of backticks inside it, so a pipe, a backtick or a tag in a comment stays text.
The evidence rail beside the report carries the trust level, the limits and
every cut list on screen.

## Analysis status

What this analysis could and could not see, in one place, read from the top. It
used to be spread over the Overview's side column, the masthead's chips and a
Rules tab of its own. Every row is the one `overview` answer Start is drawn
from, so the two can never disagree. The first view is **Scope and gaps**; the
second is **Rules**.

- **How fresh**: whether the pack still matches your working tree, in the
  masthead chip's words, with when, from which commit and with which digest it
  was built.
- **Verification**: the computed trust level, what it means, the two things
  that move it where there is no golden set, and every gate and known gap it
  names.
- **How it was counted**: the mode and depth of the census every share on Start
  and every count here was walked in, and the grades that mode follows.
- **The axes**: one row per axis (schema, SQL, columns, code, frontend calls,
  screens, and the Java bridges where they ran): collected, only partly read or
  not collected; where it was read from; what it changes when it is not whole;
  and the engine's own reason.
- **What we could not see**: every blind spot the overview names, as a row,
  grouped by what you can do about it: inputs it did not have, what it could not
  read, what this walk left out, what nothing reaches (worth a look, not an
  error), and what is said for the record. Each row says three things: the
  **cause**, the engine's own sentence, cut to its first line and opening to the
  whole; what it **touches**, in the page's words and, where the answer names
  them, the routes, statements or tables themselves, each a way into Trace; and
  **what to do**. A kind the page has no words for is still listed, in its
  group's words.
- **What the lanes reported**: the lanes' diagnostics, one row per kind with its
  count, and inside it one line per thing the rows say (names, paths and counts
  taken out, so two ways of failing stay two lines), the first few in full, and
  what to do. A moved cache once left 866 rows of one kind in this list; now it
  is one row with its count.
- Connected projects, the ribbon that shows how far the chain gets, and the
  census: edges by type and grade, nodes by kind, and the Java side.
- The evidence rail beside it carries every limit, word for word; the masthead's
  limits chip opens the same list.

The limits that change ONE answer are also said beside that answer on Trace
(what limited this answer, and what this walk left out): this place holds the
whole list, not the only copy.

A link from elsewhere (an axis chip or a gap on Start, a share's limit line, a
masthead count that was not collected) opens this place at that row, opened and
marked.

**Connected projects.** Where this project calls a route it does not serve, a
panel lists who answers it: one row per registered project, with the routes and
how many methods here make each call, five routes and then a count. Clicking a
row goes to that project. A last row holds the calls no registered project
serves, with the one thing you can do about it, which is to register the project
that serves them. On a project that calls nobody the panel is absent, because a
panel saying zero about something this pack does not do is noise.

### Rules

What the engine knows about frameworks is in rule packs ([rules.md](rules.md)),
and this view reads them through the `rules` tool, the same answer a model gets
over MCP ([mcp.md](mcp.md#rules)). It opens on the rules that gave something in
this project, the biggest first, with the rest one click away (**applies here**
or **all**). A NestJS project used to open on a MyBatis-Plus-Join rule that did
nothing for it.

A search box and a kind and a lane filter narrow the rows the answer already
holds, and ask the server nothing. A rule shows its description, why it is
there, its params, what a library rule relies on and where that is written, the
strongest grade its links may carry, and what it gave here: its links by grade
and its nodes by kind, so `nestjs.routes` on ghostfolio reads EXACT 1 and
HEURISTIC 117. Its links are listed ten at a time, and each end opens on Trace.
A rule of a kind that only classifies, where the pack names it nowhere, says
there is nothing to count, which is not the same as unused. Each example says
whether it holds, from `GET /api/rules/examples`, which runs them the way
`cascade rules test` does.

## One server, many projects

The server serves every project in `~/.cascade/registry.json` unless you narrow
it. **The page shows one project at a time**, because an answer that does not
say which pack it came from is worse than no answer.

- **The header carries the selector.** More than one project served: a
  `<select>`. Exactly one: a static label, because there is no choice to offer.
  None at all: a line saying so, naming `cascade init` and `cascade analyze`.
- **Selecting a project is not a filter.** It is a different pack, so everything
  on screen is wrong until it is asked again. Every view's cached answer is
  dropped, Start's target and map and Trace's question with them, the Graph,
  `Around <node>` and table-link renderers are torn down, the Graph goes back to
  the whole-project map, and the landing answer Start and Analysis status are
  drawn from is asked again. Nothing is reused across projects. Your mode and
  depth on Trace stay, because they are your settings, not the pack's.
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
http://127.0.0.1:4319/#p=<project>&tab=<start|trace|graph|erd|coupling|tx|compare|status|rules>
                       [&pick=<kind>:<id>][&dir=<down|up|detail>&mode=<mode>&depth=<n>][&src=<kind>:<id>]
```

`tab` names a view. On Trace the link carries the whole question: the target,
the direction, the mode and the depth (left out for **all**), so a shared link
asks the same question. Reloading lands on the same project, the same view, the
same question and the same source pane, and you can send the link to somebody
else.

A new target or a new direction on Trace pushes a history entry, as a pick on
the Graph or on Table links and an opened source pane do, so the browser's Back
button walks back through the questions you asked one at a time, and an answer
still in memory is drawn again without asking the server. An answer is
remembered under everything that shaped it (project, target, direction, mode,
depth, rows per lane), so one asked in another mode is never handed back as this
one. A new mode or depth for the same question, a view change and a project
change replace the entry instead, because none is a step you want to undo one
at a time.

**A link written before the places still lands where it did.** `tab=overview`
opens Start; `tab=explore`, `tab=flow` and `tab=impact` open Trace on the same
target read as Details, walked down and walked up; `tab=graph`, `tab=erd`,
`tab=coupling` and `tab=tx` open that view of Structure, and `tab=structure` its
Graph; `tab=rules` opens the Rules view of Analysis status. The project, the
pick and the source pane come with it, and the page then writes the new form.

On load the project is taken from, in order: the hash, the `?project=` query the
CLI prints at start-up, then what this browser chose last time
(`localStorage`). A project the server does not serve is ignored rather than
sent, so you get the first served project instead of an error.

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
Start, the map, Analysis status and Trace's lanes are drawn again from the
answers in memory.

### What is translated, and what is not

Translated: the **chrome**, meaning every word the *page* wrote for itself.

- place and view names, header labels, the project selector, the language toggle
- buttons, toggles, select options, input placeholders, tooltips
- the lead and the paragraph under each view's fold
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
uses it: one wording per grade, used by the lane legend, every badge's tooltip,
the SVG legend and what this walk left out.

### Where the strings live

- `src/viewer/i18n.mjs` holds the lookup (`makeT`, `interpolate`, `richText`)
  and the **English** catalogue, `VIEWER_STRINGS.en`. The page cannot `import`,
  so the local server hands it this very module at `GET /viewer/lib/i18n.js`,
  minus its `export ` keywords. One file: there is no copy to drift, and
  `test/i18n.test.mjs` checks that what is served is the module.
- `viewer/i18n/<lang>.json` is one file per other language, served by
  `GET /i18n/<lang>.json` from an allowlisted directory, like `/vendor`: only
  `.json`, only out of that directory, and every escape a 404.

The translations are files rather than page content on purpose. The English-only
gate (`test/gates.test.mjs`) scans `src`, `bin`, `adapters`, `scripts`,
`viewer/index.html` and `viewer/js` for non-English text, and `viewer/i18n` is
the single excluded path, the one place non-English text is expected.

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
at most 90 characters, a paragraph of at most four sentences, every Korean
sentence in the polite 합니다체 rather than the flat note-taking register, and no
space between a Latin word, a number or a closing bracket and the Korean
particle that ends it (`SQL까지`, `API에`), checked on the string with its
placeholders filled.

### Adding a language

1. Copy `viewer/i18n/ko.json` to `viewer/i18n/<lang>.json` and translate the
   values. Keep every `{placeholder}`: `test/i18n.test.mjs` checks that a
   translation did not drop one, because `{message}` is where the engine's own
   sentence goes.
2. Give the file its own name in `lang.label`, since the toggle shows each
   language in its own language.
3. Add the code to `LANGS` in `viewer/js/00_state.js`.

The key set is enforced. A translation must carry exactly the English keys: no
fewer, so nothing silently falls back, and no more, so a stale key cannot
linger.

## Where to read next

[concepts.md](concepts.md) explains the grades, the partial packs and what an
empty answer means. [mcp.md](mcp.md) is the same question surface, for a model
instead of a person.
