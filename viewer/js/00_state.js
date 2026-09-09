// 00_state.js — what the page is made of: the vocabulary it draws with, and the state it holds.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

const GRADES = ['EXACT','SOUND_SET','HEURISTIC','RUNTIME_ONLY','UNRESOLVED'];
const KINDS = ['column','table','statement','symbol','endpoint','domain'];
// ---------- the drawing vocabulary: a line for certainty, a glyph for kind ----
// ---------- the token accessor: ONE place the page reads a colour ------------
// An SVG presentation attribute and a canvas paint both have to be a LITERAL
// colour — `var(--x)` never survives either — so every drawing on this page asks
// here instead of naming a hue. The value comes from the live custom property on
// <html>, which is what makes a theme switch re-draw everything: nothing is
// hard-coded, so nothing has to be told twice.
//
// getComputedStyle is not free and the canvases call this per node per frame, so
// the answers are MEMOISED. The cache is cleared on a theme change (the only
// thing that can move these values) — never staler than the theme it was read in.
const THEME_TOKENS=new Map();
const cssVar=(name)=>{
  const hit=THEME_TOKENS.get(name);
  if(hit!==undefined) return hit;
  const v=getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  THEME_TOKENS.set(name, v);
  return v;
};
const themeForget=()=> THEME_TOKENS.clear();
// A hue's own glow, for a canvas: `--glow` is a CSS shadow expression the
// browser applies to boxes, and a canvas has ctx.shadowBlur instead. The theme
// says WHETHER a lit thing glows; this reads that one bit out of the token.
const themeGlows=()=> cssVar('--glow')!=='none';
// CERTAINTY IS A LINE. The same five strokes everywhere on this page — the
// chips, the legends, the Flow/Impact lane connectors and every link in the
// Graph, Around and ERD pictures:
//   EXACT solid · SOUND_SET dashed · HEURISTIC dash-dot · RUNTIME_ONLY dotted ·
//   UNRESOLVED the outline only, muted, with a slash through the chip.
// The grade's NAME is printed beside every one of them, so nothing here rests
// on the stroke alone — and the page says the same thing in greyscale.
const GRADE_DASH = { EXACT:null, SOUND_SET:'6 3', HEURISTIC:'6 3 1.5 3', RUNTIME_ONLY:'1.5 3', UNRESOLVED:'1.5 3' };
const gradeDash=(g)=> GRADE_DASH[g] || null;
// The theme's LINE colour for every grade but the one the engine could not
// resolve, which is muted: a relation nothing established must not be drawn as
// firmly as one that was. The colour says nothing here — the DASH is the grade.
const gradeColor=(g)=> cssVar(g==='UNRESOLVED' ? '--t3' : '--edge');
// A NODE'S KIND IS A SYMBOL — in the LANE ROWS and the ERD legend, which is
// where this is still used. The six glyphs were tried on the map too and lost:
// at three to eight pixels across a triangle, a diamond and a rectangle are
// three smudges, and the reader was left counting corners instead of reading
// the shape of the system. So the map, Around and the Overview's cartography
// draw one circle per node and say the kind in its FILL (`--n-*`, kindFill
// below), exactly as the ERD already did. Certainty is still the line pattern,
// which is the part that survives a photocopier.
// A CONNECTED PROJECT is drawn like a group, because that is what it is here:
// the skeleton the nodes that came from that pack hang off (RM45).
const KIND_GLYPH = { domain:'ring', group:'ring', project:'ring', endpoint:'tri', symbol:'circ',
  service:'circ', entry:'circ', statement:'diam', table:'rect', column:'dot',
  // A screen is a WINDOW: a frame with a title bar, which is the one shape here
  // that reads as "something a person looks at". A frontend function is a
  // method like any other, so it keeps the method's ring and is told apart by
  // its own hue.
  screen:'win', webfn:'circ' };
const KIND_TOKEN = { domain:'--k-group', group:'--k-group', project:'--k-group', endpoint:'--k-endpoint',
  symbol:'--k-service', service:'--k-service', entry:'--k-service',
  statement:'--k-statement', table:'--k-table', column:'--k-column',
  // The two lanes of the round trip that live in the browser (RM31).
  screen:'--k-screen', webfn:'--k-webfn' };
const kindColor = (kind)=> cssVar(KIND_TOKEN[kind] || '--t1');
// WHAT A KIND IS CALLED, in the reader's language. The four the map draws have
// a name in the catalogue (the legend already used them); anything else is the
// engine's own word, relayed as it stands.
// Each key is spelled out, not built: a key assembled at runtime is a key the
// catalogue tests cannot see, and a translation nobody can prove is there.
const KIND_NAME_KEY={ group:'mapleg.group', endpoint:'mapleg.endpoint',
  table:'mapleg.table', statement:'mapleg.statement', screen:'mapleg.screen',
  project:'mapleg.project' };
const kindName=(k)=> KIND_NAME_KEY[k] ? t(KIND_NAME_KEY[k]) : String(k);
// The FILL a node of this kind is drawn with on the three pictures. Four kinds
// have one; anything else falls back to the ink its name is written in.
const KIND_FILL = { domain:'--n-group', group:'--n-group', project:'--n-group', endpoint:'--n-endpoint',
  statement:'--n-statement', table:'--n-table', screen:'--n-screen' };
const kindFill = (kind)=> KIND_FILL[kind] ? cssVar(KIND_FILL[kind]) : kindColor(kind);
// ONE HUE PER CONNECTED PROJECT (RM45). A node that came from another pack
// keeps its KIND's fill - a table is still drawn as a table - and wears a RING
// in its project's own hue, so the reader can tell two siblings apart without
// reading a word. The hues are assigned in sorted project order, so the same
// server draws the same colours every time. In the DRAWING theme every kind is
// one ink and a coloured ring would be the only hue on a page that has none,
// so there the ring is the edge ink and the chip on the label is what names
// the project - the same rule the ERD's family tints already follow.
const FED_RING_TOKENS=['--k-endpoint','--k-column','--k-statement','--k-service','--k-webfn'];
function fedRingColor(projects){
  const at=new Map([...new Set((projects||[]).filter(Boolean))].sort().map((p,i)=>[p,i]));
  return (p)=> (themeGlows() && at.has(p))
    ? cssVar(FED_RING_TOKENS[at.get(p)%FED_RING_TOKENS.length])
    : cssVar('--edge');
}

// English is compiled into this page; every other language arrives as JSON from
// /i18n/<lang>.json. That is not an optimisation — it is what keeps this file
// English-only, which is what the runtime-language gate scans for. A catalogue
// that fails to load costs nothing: `makeT` falls back to English key by key.
const LANGS=['en','ko'];
const LS_LANG='cascade.viewer.lang', LS_PROJECT='cascade.viewer.project';
// THE THEME. Two of them, one token system (see the two [data-theme] blocks at
// the top of this file): `signal` is the dark instrument panel and the DEFAULT,
// `drawing` the light engineering drawing this page used to be. The choice is
// the reader's and is remembered; `prefers-color-scheme` is deliberately NOT
// consulted — the product has a default and the reader overrides it, rather
// than the operating system deciding what this page looks like.
const THEMES=['signal','drawing'];
const LS_THEME='cascade.viewer.theme';
const lsGet=(k)=>{ try{ return localStorage.getItem(k); }catch(e){ return null; } };
const lsSet=(k,v)=>{ try{ localStorage.setItem(k,v); }catch(e){ /* storage switched off: the choice is simply not remembered */ } };

// ---------- which project this page is about ----------
// A server that serves ONE project needs nothing; one that serves several
// answers `ambiguous` until the page says which. The choice is read, in order,
// from the URL hash (`#p=<id>&tab=…`, so a deep link lands where it says), the
// `?project=` query the server prints at start-up, and localStorage.
//
// Every API call carries it, and every ANSWER is tagged with the project it was
// asked FOR: one that arrives after the reader has moved elsewhere is dropped,
// never drawn. That is the GMAP.seq rule applied to the whole page — a deep
// link into another project must not flash this project's answer.
const STATE={ project:null, projects:[], meta:null, tab:'overview', seq:0 };

// ---------- THE SOURCE PANE: the evidence, at reading size -------------------
//
// The picture is the CLAIM; the source is the EVIDENCE, and evidence has to be
// readable where the claim is made. Every tab used to draw its own preview into
// whatever box it had beside it — on Flow that was a 286 by 360 pixel `pre`
// inside the 320px side panel, holding 35 lines of a MyBatis statement with
// 673px of scroll behind it, no line numbers, nothing marking the line the
// answer was about, and no way to enlarge it.
//
// There is now ONE pane for the page, and every one of those call sites opens
// it: Explore's rows, the Flow / Impact row card, the Graph map and Around
// cards, and the Transactions boundary. It is docked right, full height under
// the masthead, and carries NO SCRIM: the reader goes on clicking rows and
// nodes underneath and the pane follows them, the way an IDE preview does.
//
// THE PAGE RE-DERIVES NOTHING. The gutter numbers, the marked range, the file
// length and the absolute path an editor is opened at are all fields of
// /api/source; the page only draws them.
const LS_SRCW='cascade.viewer.srcpane.w', LS_EDITOR='cascade.viewer.editor';
const SRC_MIN_W=420, SRC_DEF_SHARE=0.56, SRC_MAX_SHARE=0.9;
const SRC_CTX=3;        // lines of context above the mark, when it is scrolled to
const SRC_EXCERPT=6;    // lines the Flow / Impact card keeps beside its button
const SRC_MEM=24;       // answers kept, so a Back button costs no request
const SRC_SAID_MS=1200; // how long the path says "copied"
// The three editors this pane knows, and the URL each one opens a file at. A
// reader who wants neither gets the path to paste, which is what `none` is for.
const SRC_EDITORS=[
  ['vscode','VS Code', (abs,line)=> 'vscode://file/'+abs+':'+line+':1'],
  ['idea','IntelliJ IDEA', (abs,line)=> 'idea://open?file='+encodeURIComponent(abs)+'&line='+line],
  ['none','none', null],
];
// Light colouring, three regexes per language and nothing cleverer: a comment,
// a string literal, an XML tag. Each is applied to ONE LINE at a time, so a
// block comment that runs over three lines colours the part on each line and
// never swallows the rest of the file when it is unterminated.
const SRC_PAINT={
  java: [[/\/\/[^\n]*|\/\*.*?\*\//g,'srccm'], [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,'srcst']],
  // The frontend lane's three languages, plus the backtick string JavaScript
  // has and Java does not. A .vue file is painted as whatever its own script
  // tag declares (the engine reads the tag, this page does not guess), so a
  // component previewed whole has its template painted by those rules too.
  js:   [[/\/\/[^\n]*|\/\*.*?\*\//g,'srccm'], [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,'srcst']],
  ts:   [[/\/\/[^\n]*|\/\*.*?\*\//g,'srccm'], [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,'srcst']],
  tsx:  [[/\/\/[^\n]*|\/\*.*?\*\//g,'srccm'], [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,'srcst']],
  sql:  [[/--[^\n]*|\/\*.*?\*\//g,'srccm'], [/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g,'srcst']],
  xml:  [[/<!--.*?-->/g,'srccm'], [/<\/?[A-Za-z!?][^>]*>/g,'srctg']],
};
const SRC={ open:false, node:null, tab:null, whole:false, resp:null, loading:false,
  error:null, grade:null, basis:null, excerpt:null, seq:0, inflight:null, mem:new Map() };

// ---------- ONE WAY BACK -----------------------------------------------------
//
// Every narrowing on this page is a door, and until now most of them were one
// way: after a pick on Explore, Flow or Impact nothing on screen said how to
// get the whole list back, on the Graph tab the way back was an Escape key
// nothing mentioned, and on the ERD it was a click on empty canvas.
//
// So every tab that can narrow carries the SAME control, in the same place (the
// right end of its own toolbar), and it is disabled while the tab already IS
// its opening state — which makes the button a readout as well as a way back.
// Escape does the same thing from anywhere in the tab, and the browser's own
// Back button undoes one pick at a time, because a pick now writes the URL.
const SHOWALL = { explore:'exshowall', flow:'fshowall', impact:'ishowall', graph:'gshowall', erd:'eshowall' };
// The last pick each of those tabs made, as a full `<kind>:<key>` node id, and
// the answer it was drawn from. The ID goes in the URL, so a reload lands on the
// same picture; the ANSWER stays here, so a Back button costs no request.
const PICK = { explore:null, flow:null, impact:null, graph:null, erd:null };
const PICKMEM = new Map();
const PICKMEM_MAX = 24;
// True while the page is APPLYING a URL rather than writing one: without it,
// restoring a pick would push a new history entry on top of the one it came
// from and the Back button would never get anywhere.
// One scope, thirteen files: this is set and put back by writeHash() in
// 20_api.js and by railPick() in 41_explore.js, which a linter reading one file
// at a time cannot see.
// eslint-disable-next-line prefer-const -- reassigned in another file of this scope
let HASHLOCK = false;

// ---------- the browse rail: Explore, Flow and Impact open on the pack -------
//
// A search box is a question you have to already know the answer to. These three
// tabs used to open on one, so the first screen of a project you had never seen
// was an empty input and a sentence telling you to type something. They now open
// on a LIST: the kinds this tab can show with their counts, a filter over the
// rows already on screen, a sort that puts the busiest first, and the rows
// themselves with the numbers you would pick by.
//
// THE PAGE COUNTS NOTHING. Every row, every count and every chip number is one
// `browse` answer (src/mcp/tools.mjs), kept in `RAIL[tab].resp` so a language
// switch re-draws the rail from memory and asks the server for nothing. Typing
// in the filter sends NO request either: it is a substring test over the rows
// already loaded. The one exception is `kind=symbol`, where the server refuses
// to list ten thousand methods and the filter IS the query it asks for.

const RAIL_PAGE = 200;        // the server's own page size, and the step `show more` takes
const RAIL_FILTER_MS = 120;   // the debounce on a filter that asks nothing
const RAIL_SYMBOL_MS = 250;   // ...and on the one kind whose filter is a server query
// The sorts each kind offers, MIRRORING src/mcp/tools.mjs BROWSE_SORTS. The page
// may not invent one: an unknown sort is a bad-input from the server.
const RAIL_SORTS = {
  table: ['statements', 'endpoints', 'groups', 'columns', 'name'],
  column: ['writes', 'reads', 'endpoints', 'name'],
  statement: ['tables', 'name'],
  endpoint: ['tables', 'statements', 'path'],
  symbol: ['name'],
  screen: ['endpoints', 'tables', 'name'],
};
const RAIL_IDFIELD = { table:'table', column:'column', statement:'statement', endpoint:'endpoint',
  symbol:'symbol', screen:'screen' };
// The catalogue keys, written out rather than built by concatenation: a key this
// page assembles at run time is a key test/i18n.test.mjs cannot check exists.
const RAIL_KIND_KEY = { table:'rail.kind.table', column:'rail.kind.column',
  statement:'rail.kind.statement', endpoint:'rail.kind.endpoint', symbol:'rail.kind.symbol',
  screen:'rail.kind.screen' };
const RAIL_SORT_KEY = { name:'rail.sort.name', path:'rail.sort.path', tables:'rail.sort.tables',
  statements:'rail.sort.statements', endpoints:'rail.sort.endpoints', groups:'rail.sort.groups',
  columns:'rail.sort.columns', reads:'rail.sort.reads', writes:'rail.sort.writes' };
// Impact is read for one question ("what would a change here break?"), so its
// table list opens on the tables the most endpoints reach, not the busiest SQL.
const RAIL_TAB_SORT = { impact: { table:'endpoints' } };
const RAILDEF = {
  explore: { kinds:['table','column','statement','endpoint','symbol','screen'], kind:'table',
    railId:'exrail', listId:'exlist', countId:'excount', moreId:'exmore', sortId:'exsort',
    chipsId:'exkinds', drawerId:'exdrawer', closeId:'exclose', inputId:'q', lead:'rail.lead.explore' },
  // Flow can be walked from either end of the round trip: the routes this pack
  // serves, or the screens that call them. The switch is remembered per
  // project, because which end you read from is a property of the project you
  // are reading, not of the browser.
  flow: { kinds:['endpoint','screen'], kind:'endpoint',
    railId:'flowrail', listId:'flist', countId:'fcount', moreId:'fmore', sortId:'fsort',
    chipsId:'fkinds', drawerId:'fdrawer', closeId:'fclose', inputId:'fentry', lead:'rail.lead.flow' },
  impact: { kinds:['table','statement','symbol'], kind:'table',
    railId:'impactrail', listId:'ilist', countId:'icount', moreId:'imore', sortId:'isort',
    chipsId:'ikinds', drawerId:'idrawer', closeId:'iclose', inputId:'ientry', lead:'rail.lead.impact' },
};
const RAILTABS = Object.keys(RAILDEF);
const RAIL = {};
for (const tab of RAILTABS) RAIL[tab] = railFresh(tab);
// eslint-disable-next-line prefer-const -- set by railOpenDrawer() in 41_explore.js.
let RAILOPEN = null;   // which tab's drawer is over the content, under 1100px

function railFresh(tab){
  const d = RAILDEF[tab];
  return { kind:d.kind, sort:railDefaultSort(tab, d.kind), resp:null, counts:null,
    rows:[], hays:[], shown:[], rowEls:[], q:'', typed:'', cur:-1, sel:null, selKind:null,
    seq:0, timer:null, more:false, loading:false, needQuery:false, error:null,
    closedGroups:new Set(), openTables:new Set(), cols:new Map(),
    // One `browse` answer per kind this tab has already asked for, so going
    // back to a list costs nothing. `Show all` puts the rail on the kind the
    // tab OPENED on, and that must not put a request on the wire for a list
    // the reader has already been shown.
    byKind:new Map() };
}
function railDefaultSort(tab, kind){
  const per = RAIL_TAB_SORT[tab];
  return (per && per[kind]) || RAIL_SORTS[kind][0];
}

// ---------- Flow + Impact tabs: ONE chain renderer, walked either way ----------
// The SERVER walks (tool `flow`, direction=down|up); this only draws what came
// back. Every row is keyed by its FULL node id, and a link is drawn only when
// BOTH ends are on screen — a row cut by the limit means no line, never a line
// to nowhere.
//
// The two tabs share every function below. Nothing here reads a module-level
// `flowRows` / `flowPaths`: each tab owns a VIEW STATE that is passed in, so
// both pictures can be live at once and neither can overwrite the other's
// measurements (a hover on Impact must not dim the rows on Flow).
function makeChainView(o){
  return {
    name:o.name, direction:o.direction,
    wrapId:o.wrapId, sideId:o.sideId, entryId:o.entryId, sugId:o.sugId,
    modeId:o.modeId, depthId:o.depthId, segId:o.segId,
    resp:null, limit:40, sel:null, view:'lanes',
    layerOpen:new Set(),          // hops whose rows are expanded in layers mode
    // A late answer is NEVER the current answer: every async render carries a
    // sequence number and drops itself if a newer request has started since.
    seq:0, sugSeq:0, sugTimer:null, sugItems:[], sugRows:[], sugCur:-1, sugMoved:false, sugLast:null,
    pick:null,                    // {kind,value} the typeahead resolved, if any
    rows:new Map(),               // node id -> {els:[…], kind, grade, data}
    linkSpecs:[], paths:[],       // wanted links, then the ones actually drawn
  };
}
const FLOWV = makeChainView({name:'flow', direction:'down', wrapId:'flowwrap', sideId:'flowside',
  entryId:'fentry', sugId:'fsug', modeId:'fmode', depthId:'fdepth', segId:'fview'});
const IMPACTV = makeChainView({name:'impact', direction:'up', wrapId:'impactwrap', sideId:'impactside',
  entryId:'ientry', sugId:'isug', modeId:'imode', depthId:'idepth', segId:'iview'});

// ---------- Graph tab: one node's neighborhood, laid out by hop ----------
// The answer is `neighborhood`'s: nodes and graded edges around a focus. The
// page adds two things it can compute honestly from that answer — how many hops
// each node is from the focus (a BFS over the very edges it was sent) and how
// many of the DRAWN edges touch each node — and hands the rest to the shared
// engine. Rings are the reading: hop 0 at the centre, hop 1 around it, and so on.
const GRING={step:130, gap:15, nodeR:9};
const GRAPHV={ name:'graph', direction:'graph', entryId:'gfocus', sugId:'gsug',
  // 'map' — the whole pack (the default the tab opens on); 'around' — these
  // hop rings, the drill-down. The entry box is shared, so what a commit MEANS
  // is decided by the sub-mode, not by a second box.
  mode:'map',
  resp:null, seq:0, sel:null, hop:new Map(), hidden:new Set(), hiddenFor:null, counts:null,
  sugSeq:0, sugTimer:null, sugItems:[], sugRows:[], sugCur:-1, sugMoved:false, sugLast:null, pick:null };
GRAPHV.draw=()=> GRAPHV.mode==='map' ? mapCommitSearch() : drawGraph();
// The live `Around <node>` picture: its view models, what is lit, and the
// renderer handle. The ANSWER stays in GRAPHV — this is only the drawing.
const gaDimLink=()=> cssVar('--dim-link');
const GA={ api:null, nodes:[], links:[], byId:new Map(), incident:new Map(),
  plan:[], cx:0, cy:0, parked:null, hover:null, lit:null, labels:new Map(), always:new Set(),
  frame:{labels:0}, fitDone:false, lastClick:{id:null,at:0} };
/** Has the reader's system asked for less motion? Nothing animates if so. */
const reducedMotion=()=> typeof matchMedia==='function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Whether the call-direction particles run before anybody has said. */
function mapFlowDefault(){
  if(reducedMotion()) return false;
  return themeGlows();   // the drawing theme has no motion anywhere on the page
}

// WHERE the map is mounted. The Overview's cartography and the Graph tab draw
// the SAME answer with the SAME renderer, at two sizes — only one of them is on
// screen at a time (they are tabs), so only one renderer is ever alive. Moving
// between them tears the old mount down (which saves the settled positions) and
// mounts in the other host, so the picture the reader learned comes back.
const GMAP={ where:'graph', mounted:null,
  resp:null, seq:0, findSeq:0, rend:'2d', drawn:null, api:null,
  sel:null, hover:null, lit:null, litLabels:new Set(), restLabels:new Set(),
  hidden:new Set(), layers:false,
  // THE CONNECTED PROJECTS LAYER (RM45). On by default: an answer that crossed
  // packs is the answer, and hiding it would leave the reader looking at a map
  // with two dead-end routes on it. Remembered like the other switches, and
  // `fedColor` is the one place a sibling's hue is decided, so the nodes, the
  // lines and the legend can never disagree about it.
  fed:true, fedColor:()=>null, fedProjects:[],
  // THE SCREENS LAYER (RM31). null means "not decided yet": the default is a
  // COUNT, and the count lives in the overview answer, which may not have
  // landed when a deep link opens straight on this tab. Decided once, by
  // mapScreensDecide, and after that it is the reader's own switch.
  screens:null,
  // THE SETTLED LAYOUT, one cache per dimension. A picture the reader has
  // learned must survive every fold, spotlight, theme change and trip through
  // Around, so once a layout has settled it is saved here WITH ITS PINS and
  // every later mount is drawn from it rather than laid out again.
  pos:new Map(), pos3:new Map(),
  // WHICH GROUPS ARE UNFOLDED. At rest this is empty and the map draws groups
  // and tables only; a group in here is drawn with its endpoints around it and
  // its aggregate lines faded. It is a RENDERING state — the answer, the
  // census and the `map` tool's reply are untouched by it.
  open:new Set(),
  // The answer, indexed the way the aggregation needs it (see mapIndexAnswer).
  epGroup:new Map(), groupEps:new Map(), epTables:new Map(), answerById:new Map(),
  endpointsTotal:0,
  // Which dimension the LAST mount saved into, for anything that wants to know
  // what is on screen: 0 nothing, 2 the flat cache, 3 the volume one.
  posDim:0,
  // The call-direction animation: on by default, remembered across renders and
  // across the 2D/3D switch. flowRest is the performance guard, recomputed with
  // the model: past the cap the RESTING map is still and only a lit node flows.
  // Motion is a choice, and a reader who asked their system for less of it has
  // already made it: the call-direction particles start OFF for them.
  // Motion is a choice twice over. A reader who asked their system for less of
  // it has already made it, and so has one who asked for the DRAWING theme —
  // that theme has no motion anywhere, and a moving dot on a still sheet would
  // be the one thing on the page that ignores what was chosen. Either way the
  // toggle in the toolbar overrides it, and once it has been touched
  // (`flowTouched`) a later theme change leaves the reader's answer alone.
  flow:mapFlowDefault(), flowTouched:false,
  flowRest:true, directed:0,
  nodes:[], links:[], byId:new Map(), incident:new Map(), placed:[],
  // WHAT THE NEXT MOUNT DOES. 'full' is a real settle (a new answer, or the fit
  // button); 'local' gives ONLY the nodes that have never been placed a short
  // run and holds everything else still; 'none' repaints the saved layout with
  // no simulation at all. Everything but a new answer and the fit button is
  // 'local' or 'none', which is what makes a click land where the reader aimed.
  layout:'full', find:'',
  // The fit is per DIMENSION: coming back to 2D reuses its own last zoom and
  // centre instead of refitting the picture under the reader.
  fit:{'2d':false, '3d':false}, view2d:null,
  // How much bigger than the layout radius a 3D sphere is DRAWN, decided by
  // measurement once the camera has landed (map3dSizeCorrect). 1 until then.
  r3d:1, sized3d:0,
  fitDone:false, labelRaf:null, labelAt:0, fitTimer:null, lastClick:{id:null,at:0}, fellBack:false, webgl:null, scale3d:1 };
// The live picture: its view models, the renderer handle, what is spotlighted,
// and the family colouring the legend, the nodes and the isolated strip all read
// from — derived once per draw, so the three can never disagree about what
// colour a family is.
const ERD={ api:null, famColor:null, sideSeq:0, answer:null, iso:[], cols:new Map(),
  // THE CONNECTED PROJECTS (RM45): one cluster per registered project a request
  // from this one reaches. `fedColor` is the ONE place a project's hue is
  // decided, so the frames, the markers and the legend cannot disagree.
  clusters:[], fedColor:()=>null, fitBox:null, fitMargin:0, fitScale:1,
  nodes:[], links:[], byId:new Map(), incident:new Map(),
  sel:null, hover:null, lit:null, labels:new Map(), always:new Set(), labelAll:false, legend:null,
  // What the placer ACTUALLY drew, the last frame it ran at rest — {wanted,
  // placed}. The stats line reports THIS, never what was asked for: a name the
  // placer dropped (it would have landed on a neighbour) leaves a rectangle
  // with no name on it, and the line may not claim the reader can read it.
  // null until the first frame has run, so the line says nothing it cannot know.
  placed:null,
  detail:false, frame:{labels:0, glyphs:0, cards:0}, frames:0, fitDone:false,
  W:900, H:620 };

// ---------- Coupling tab — which API group writes what another one reads ----------
// The SERVER builds the matrix (tool `coupling`); this only draws it. A cell is
// a COUNT of shared columns/tables, so it is painted in ONE hue at varying
// strength — never in the grade colours, which mean something else entirely.
// The ranked pair list is the primary reading (the matrix is sparse by nature);
// the matrix is the overview and the way into a pair.
const CP={resp:null, sel:null, seq:0, axis:'column', showAll:false, cellEls:new Map()};

// ---------- Overview tab: the pack at a glance, from ONE answer ----------
// The landing page. It asks the server once and draws what comes back: the
// ribbon, the census, the gaps and the hubs are all fields of that one
// response, so nothing here can disagree with the engine. The only arithmetic
// the page does is a band's height and the "n of total" split of two numbers
// the answer already carries — it never walks the graph itself.
const OV = { resp:null, screens:null };
