// 55_trace_detail.js — the Trace place's third direction: what the target IS.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.
//
// DETAILS ARE LISTS, NOT A WALK. A table's SQL and its columns with their read
// and write counts, a column's statements with read or write on each row, a
// screen's functions, routes and tables, and for a route, a method or a
// statement the card of the thing itself: where it is, how sure its own link
// is, and for a route or a method the transactions it runs through, each one a
// way into the Transactions tab. Every list is one tool answer; the page counts
// nothing.

/** Ask for the details of the target on screen, or draw them from memory under the whole key. */
async function traceDetail(){
  const tg = TRACE.target;
  if(!tg) return;
  tracePane('detail');
  const key = traceKey(traceNow());
  const memo = PICKMEM.get(key);
  if(memo){ traceDetailDraw(tg, memo); TRACEV.lastKey = key; traceWritePick(); return; }
  view.replaceChildren(el('div', { className:'panel', textContent:t('load.detail') }));
  const mine = ++TRACEV.seq;
  let got;
  try{ got = await traceDetailAsk(tg); }
  catch(e){ if(stale(e) || mine !== TRACEV.seq) return; view.replaceChildren(errPanel(e)); return; }
  if(mine !== TRACEV.seq) return;
  pickRemember(key, got);
  TRACEV.lastKey = key;
  traceDetailDraw(tg, got);
  traceWritePick();
}
/**
 * One target's details, as the tools answer them. The grade MODE on screen is
 * passed wherever a tool walks (a column's routes, a route's or a method's
 * transactions), so the lists agree with the picture drawn in the same mode.
 * column_impact's own `mode` is not a grade mode at all: it is which ACCESS to
 * list, and this place always asks for both, saying read or write on each row.
 */
async function traceDetailAsk(tg){
  const mode = byId('tmode').value, depth = depthArg('tdepth');
  const [got, screens] = await Promise.all([ traceDetailMain(tg, mode, depth),
    TRACE_SCREENS_OF.includes(tg.kind) ? api('screen_impact', { [tg.kind]:tg.id, mode }) : Promise.resolve(null) ]);
  return screens ? { ...got, screens } : got;
}
function traceDetailMain(tg, mode, depth){
  if(tg.kind === 'table') return api('table_usage', { table:tg.id }).then((table)=> ({ table }));
  if(tg.kind === 'column'){
    const ACCESS_BOTH = 'both';
    return Promise.all([ api('column_impact', { column:tg.id, mode:ACCESS_BOTH }), api('endpoint_impact', { column:tg.id, mode }) ])
      .then(([ci, ei])=> ({ column:{ ci, ei } }));
  }
  if(tg.kind === 'screen') return api('flow', { screen:tg.id, mode, depth, limit:200 }).then((screen)=> ({ screen }));
  // A statement's card needs only its own row: the walk up from it, one step.
  if(tg.kind === 'statement') return api('flow', { direction:'up', statement:tg.id, mode, depth:1, limit:1 }).then((entry)=> ({ entry }));
  return api('flow', { [tg.kind]:tg.id, mode, depth, limit:200 }).then((entry)=> ({ entry }));
}
function traceDetailDraw(tg, got){
  if(got.table) renderTableAnswer(tg.id, got.table);
  else if(got.column) renderColumnAnswer(tg.id, got.column.ci, got.column.ei);
  else if(got.screen) renderScreenAnswer(tg.id, got.screen);
  else renderEntryDetail(tg, got.entry);
  // The screens stand right under the card, where the side column would drop
  // them under a long list at most widths; their own evidence rail goes last.
  if(got.screens){
    const [head, ...rest] = view.children;
    view.replaceChildren(head, traceScreensPanel(got.screens), ...rest, honesty(got.screens, 'trace.screens'));
  }
  refreshShowAll();
}
// The kinds whose details say which screens a change there is felt on.
const TRACE_SCREENS_OF = ['column', 'table', 'statement', 'symbol'];
/**
 * THE SCREENS A CHANGE HERE IS FELT ON, beside the details (screen_impact). The
 * walk up in the picture stops at its depth cap, and on a pack like mall a
 * column's screens sit nine links up, past the most any walk follows; this list
 * is the same backward reach followed all the way, in the mode on screen, and
 * its heading says so. Each screen is a way into Trace, walked down.
 */
function traceScreensPanel(r){
  const a = r.answer || {};
  const rows = a.screens || [];
  return listPanel(t('detail.screens', { mode:a.mode || byId('tmode').value }), ovTotal(r, 'screens', rows.length), rows,
    (s)=> el('li', {}, [
      el('span', { className:'id', title:s.screen, textContent:s.label || s.screen }),
      el('span', { style:'display:flex;align-items:center;gap:6px;flex:none' }, [
        el('span', { className:'count', title:(s.endpoints || []).join('\n'), textContent:t('detail.screens.routes', { n:(s.endpoints || []).length }) }),
        badge(s.grade), traceButton('screen', s.screen, 'down') ]) ]),
    a.empty, 'screens');
}

// The card's heading per kind, spelled out so the catalogue tests can see each key.
const TRACE_DETAIL_TITLE = { endpoint:'trace.detail.endpoint', symbol:'trace.detail.symbol', statement:'trace.detail.statement' };
/**
 * A ROUTE, A METHOD OR A STATEMENT, as a card: what it is, where it is, how sure
 * its own link is, and what it touches. From a route or a method, the
 * @Transactional boundaries its walk runs through, each a way into the
 * Transactions tab; a method that IS one says so first.
 */
function renderEntryDetail(tg, r){
  const e = (r.answer && r.answer.entry) || {};
  const where = e.file ? e.file + (e.line ? ':' + e.line : '') : null;
  const facts = [
    e.kind === 'endpoint' && e.handler ? t('trace.detail.handler', { h:shortId('symbol:' + e.handler) }) : null,
    e.owner || null, e.statementType || null, where,
  ].filter(Boolean);
  const head = el('div', { className:'panel' }, [
    el('h2', { textContent:t(TRACE_DETAIL_TITLE[tg.kind] || 'trace.detail.symbol') }),
    el('div', { className:'srchead' }, [
      el('span', { style:'display:flex;align-items:center;gap:8px;min-width:0' }, [ kindGlyph(TRACE_GLYPH[tg.kind], 12),
        el('code', { className:'id', style:'overflow-wrap:anywhere', textContent:tg.id }),
        (e.grade && e.kind === 'endpoint') ? badge(e.grade) : null ]),
      el('button', { className:'mini', textContent:'Source', title:t('src.open.title'),
        onclick:()=> srcOpen(tg.kind + ':' + tg.id, { tab:'trace' }) }) ]),
    facts.length ? el('div', { className:'comment', textContent:facts.join('  ') }) : null,
    e.gradeBasis ? el('div', { className:'comment', textContent:e.gradeBasis }) : null,
    (e.tables && e.tables.length) ? el('div', { className:'fsub', style:'margin-top:7px' }, e.tables.map((x)=>
      el('span', { className:'tag ' + (x.access === 'read' ? 'read' : 'write'), title:x.access, textContent:x.table + ' ' + x.access }))) : null,
  ]);
  setKids(view, head, tg.kind === 'statement' ? null : traceTxPanel(tg, r), honesty(r, 'trace'));
}
/**
 * The transaction boundaries on the way down from a route or a method: the
 * method itself when it is one, then every service row of the walk marked
 * @Transactional, in the walk's order. A lane cut by the row limit says so.
 */
function traceTxPanel(tg, r){
  const a = r.answer || {}, e = a.entry || {};
  const rows = [];
  if(tg.kind === 'symbol' && e.transactional) rows.push({ id:tg.id, hops:0, self:true });
  for(const s of a.services || []) if(s.transactional) rows.push({ id:s.id, hops:s.hops, grade:s.grade });
  const tf = ((r.truncated && r.truncated.fields) || []).find((f)=> f.field === 'services');
  const cut = tf && tf.shown < tf.total;
  return el('div', { className:'panel' }, [
    el('h2', {}, [ t('trace.detail.tx') + ' ', el('span', { className:'count', textContent:'(' + rows.length + ')' }) ]),
    el('div', { className:'comment', style:'margin-bottom:6px', textContent:t('trace.detail.tx.lead', { mode:a.walk ? a.walk.mode : '', depth:a.walk ? depthText(a.walk.depth) : '' }) }),
    el('ul', { className:'list' }, rows.length ? rows.map((x)=> el('li', {}, [
      el('a', { className:'id clickable', textContent:shortId('symbol:' + x.id), title:x.id, onclick:()=> openTx(x.id) }),
      el('span', { style:'display:flex;align-items:center;gap:6px;flex:none' }, [
        x.self ? el('span', { className:'tag', textContent:t('trace.detail.tx.self') }) : hopChip('service', x.hops),
        x.grade ? badge(x.grade) : null,
        el('button', { className:'mini', textContent:t('tab.tx'), title:t('trace.detail.tx.open'), onclick:()=> openTx(x.id) }) ]) ]))
      : [ el('li', { className:'empty', textContent:t('trace.detail.tx.none') }) ]),
    cut ? el('div', { className:'count', textContent:t('trace.lim.page', { lane:laneTitle('services'), shown:tf.shown, total:tf.total }) }) : null,
  ]);
}
/** The Transactions tab, opened on one boundary. */
function openTx(method){
  activateTab('tx');
  showTx(method);
}
