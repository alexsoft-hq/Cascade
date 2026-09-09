// 43_impact.js — the Impact tab: Flow, walked upstream.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// ---- the Impact tree: one table, its own columns, ONE request ---------------
async function railToggleTable(tab, id){
  const R = RAIL[tab];
  if (R.openTables.has(id)) { R.openTables.delete(id); railRenderRows(tab); return; }
  R.openTables.add(id);
  if (R.cols.has(id)) { railRenderRows(tab); return; }   // asked once, kept
  R.cols.set(id, null);                                  // null means "on its way"
  railRenderRows(tab);
  try {
    const r = await api('browse', { kind:'column', table:id, limit:RAIL_PAGE });
    R.cols.set(id, r.answer.items || []);
  } catch(e){
    if (stale(e)) { R.cols.delete(id); return; }
    R.cols.set(id, []);
  }
  railRenderRows(tab);
}
function railChildren(tab, id){
  const R = RAIL[tab], cols = R.cols.get(id);
  if (cols == null) return el('div', { className:'brchildren' }, [el('div', { className:'empty', textContent:t('rail.tree.loading') })]);
  if (!cols.length) return el('div', { className:'brchildren' }, [el('div', { className:'empty', textContent:t('empty.none') })]);
  const kids = [];
  for (const c of cols) railRowNodes(tab, 'column', c, kids, true);
  return el('div', { className:'brchildren' }, kids);
}
// The mirror handoff: "what breaks if I change THIS?" — from an Explore head, a
// Flow row's card, or a transaction boundary. The kind is carried explicitly so
// the page never has to guess it back out of the name.
function openImpact(arg){
  activateTab('impact');
  const kind=['column','table','statement','symbol'].find(k=>arg&&arg[k]);
  byId('ientry').value = (kind?arg[kind]:'')||'';
  IMPACTV.pick = kind ? {kind, value:arg[kind]} : null;
  closeSug(IMPACTV);
  drawChain(IMPACTV);
}
