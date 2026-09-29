// 43_impact.js — the table tree in the Trace list: a table opens into its own columns.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

// ---- the Impact tree: one table, its own columns, ONE request ---------------
// A table's columns are counted in the list's mode and kept under it (RM67-U2i):
// an answer that lands after the mode moved is kept for that mode and never
// drawn in this one.
const railColKey = (tab, id) => (railMode(tab) || '') + '|' + id;
async function railToggleTable(tab, id){
  const R = RAIL[tab];
  if (R.openTables.has(id)) { R.openTables.delete(id); railRenderRows(tab); return; }
  R.openTables.add(id);
  if (R.cols.has(railColKey(tab, id))) { railRenderRows(tab); return; }   // asked once in this mode, kept
  await railAskColumns(tab, id);
}
/** Ask for one table's columns in the list's mode, and keep them under it. */
async function railAskColumns(tab, id){
  const R = RAIL[tab], key = railColKey(tab, id);
  R.cols.set(key, null);                                 // null means "on its way"
  railRenderRows(tab);
  const got = await railFetchColumns(tab, id);
  if (!got) { R.cols.delete(key); return; }
  R.cols.set(key, got);
  railRenderRows(tab);
}
/**
 * One table's columns: `{items, empty}`, or `{error}` when the lookup failed,
 * or null for an answer the page has moved on from. A FAILED LOOKUP IS NOT AN
 * EMPTY TABLE: it used to be stored as an empty list and drawn as "nothing
 * here", which on the Impact tab reads as "no column of this table is affected
 * by anything". It is kept as a failure, with the server's own sentence and a
 * way to ask again.
 */
async function railFetchColumns(tab, id){
  try {
    const r = await api('browse', { kind:'column', table:id, limit:RAIL_PAGE, mode:railMode(tab) });
    return { items:r.answer.items || [], empty:r.answer.empty || null };
  } catch(e){ return stale(e) ? null : { error:e }; }
}
/** A lookup that failed, said as one: the server's own sentence, and a way to ask again. */
function railColumnsFailed(tab, id, e){
  return el('div', { className:'empty railerr' }, [
    t('rail.tree.failed', { message:(e && e.message) || String(e) }), ' ',
    el('button', { className:'mini', textContent:t('rail.tree.retry'), onclick:() => railRetryTable(tab, id) }) ]);
}
/** Ask for a table's columns again, after a lookup that failed. */
function railRetryTable(tab, id){
  const R = RAIL[tab];
  R.cols.delete(railColKey(tab, id));
  R.openTables.delete(id);
  railToggleTable(tab, id);
}
function railChildren(tab, id){
  const R = RAIL[tab], got = R.cols.get(railColKey(tab, id));
  if (got == null) return el('div', { className:'brchildren' }, [el('div', { className:'empty', textContent:t('rail.tree.loading') })]);
  if (got.error) return el('div', { className:'brchildren' }, [railColumnsFailed(tab, id, got.error)]);
  const cols = got.items;
  if (!cols.length) return el('div', { className:'brchildren' }, [el('div', { className:'empty', textContent:emptyText(got.empty, 'items') })]);
  const kids = [];
  for (const c of cols) railRowNodes(tab, 'column', c, kids, true);
  return el('div', { className:'brchildren' }, kids);
}
