// 53_chain_lanes.js — the Flow and Impact lanes, laid out so a reader can read them.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.
//
// WHAT CHANGED (RM67). Every lane was 180px wide and cut every name to eight
// characters, the lines crossed in a knot, and 88 services were 88 rows. Now
// the answer is read into a MODEL first (laneModel): each row's key, the node it
// stands for and its hop-and-grade group, each link with the grade of that one
// link, and one name per node (chainLabels). The lanes are then ordered to cut
// crossings inside each group (orderLanes), sized to their names (laneWidth),
// and folded by owner when long (foldLane), all from src/viewer/chainlayout.mjs,
// the file the saved SVG asks too. Over the picture a strip that does not scroll
// away names the start and every lane's counts, and finds a row by name.

// The three grades a mode can walk each have a band; anything else is one more.
const LANE_BANDS=['EXACT','SOUND_SET','HEURISTIC'];
const laneBand=(g)=> LANE_BANDS.includes(g) ? g : 'other';
// How many rows one "fetch more" asks the server for.
const CHAIN_PAGE=40;

/** The node id a lane row stands for: what the naming rule reads. */
function laneNodeId(field, x){
  if(field==='tables') return 'table:'+x.table;
  if(field==='statements') return 'statement:'+x.id;
  if(field==='endpoints') return 'endpoint:'+x.id;
  if(field==='screens') return 'screen:'+x.id;
  return 'symbol:'+x.id;
}
/** Where the line into a row comes from, keyed the way the rows are. */
function laneFromKey(field, x){
  if(field==='tables') return x.via ? fkey(x,'statement:'+x.via) : null;
  if(field==='endpoints') return flinkKey(x, (x.link&&x.link.from) || (x.handler ? 'symbol:'+x.handler : null));
  return flinkKey(x, (x.link&&x.link.from)||null);
}
/**
 * THE GRADE OF THE LINK INTO A ROW, which is not the grade of its PATH. The
 * badge on a row is the weakest link from the start to it; the line into it is
 * that one step. A route walking up names its step as the last edge of its
 * walked path; a table names none, so its line carries the path's grade.
 */
function laneLinkGrade(x){
  if(x.link && x.link.grade) return x.link.grade;
  const wp=Array.isArray(x.walkedPath) && x.walkedPath.length ? x.walkedPath[x.walkedPath.length-1] : null;
  return (wp && wp.grade) || x.grade;
}
/**
 * THE PICTURE BEFORE IT IS DRAWN: every lane's rows (key, node id, group), every
 * link with the grade of that one link, and one name per node. A grouped lane
 * keeps its hop and grade bands as groups, so nothing below reorders a candidate
 * into the proven rows; a flat lane (the end of the chain) is one group.
 */
function laneModel(v, a){
  const spec=CHAIN_LANES[v.direction];
  const e=a.entry||{};
  const lanes=[{ field:null, title:spec.entryTitle, grouped:false, mk:(x)=>flowEntryRow(v,x),
    rows:[{ key:e.start, id:entryNodeId(e), x:e, hop:0, grade:e.grade||null, group:'entry' }] }];
  const links=[];
  for(const [field,title,mk,grouped] of chainLanes(v, a)){
    const rows=(a[field]||[]).map((x)=>{
      const id=laneNodeId(field, x), key=fkey(x, id), from=laneFromKey(field, x);
      if(from) links.push({ from, to:key, grade:laneLinkGrade(x), observed:linkObserved(x) });
      return { key, id, x, hop:x.hops, grade:x.grade, group: grouped ? x.hops+'|'+laneBand(x.grade) : field };
    });
    lanes.push({ field, title, grouped, mk:(x)=>mk(v,x), rows });
  }
  const labels=chainLabels(lanes.flatMap((l)=> l.rows.map((r)=> r.id)));
  for(const l of lanes) for(const r of l.rows) r.owner=(labels.get(r.id)||{}).owner||r.id;
  return { lanes, links, labels };
}
/** The rows no fold may hide: the chain through the selected row, and what the find box found. */
function laneKeep(v, m){
  const keep=new Set();
  if(v.sel) for(const k of chainThrough(m.links, v.sel)) keep.add(k);
  const q=String(v.find||'').trim().toLowerCase();
  v.found=new Set();
  if(!q) return keep;
  for(const l of m.lanes) for(const r of l.rows){
    const lab=((m.labels.get(r.id)||{}).text||'').toLowerCase();
    if(lab.includes(q) || String(r.id).toLowerCase().includes(q)){ keep.add(r.key); v.found.add(r.key); }
  }
  return keep;
}
/** Draw the lanes: ordered to cut crossings, sized to their names, folded when long. */
function laneRender(v, r, tf){
  const a=r.answer, wrap=vwrap(v), m=v.model;
  wrap.classList.remove('layersmode'); wrap.classList.add('lanesmode');
  const order=orderLanes(m.lanes.map((l)=> l.rows), m.links);
  const keep=laneKeep(v, m);
  v.proxy=new Map(); v.colKeys=[];
  const cols=m.lanes.map((lane, li)=> laneColumn(v, lane, order[li], tf, a, keep));
  v.perLine=null;
  wrap.replaceChildren(svgEl('svg',{class:'flowsvg'}), ...cols);
  v.linkSpecs=laneLinkSpecs(v, m.links);
  laneStrip(v, m, tf);
  drawChainLinks(v);
  if(v.sel && v.rows.has(v.sel)) flowHover(v, v.sel);
}
/**
 * The lines to draw: every link of the model, drawn between the items that
 * stand for its two ends (a folded row's line goes to its group), once per
 * pair and grade, and never from an item to itself.
 */
function laneLinkSpecs(v, links){
  const out=[], seen=new Set();
  for(const l of links){
    const from=v.proxy.get(l.from)||l.from, to=v.proxy.get(l.to)||l.to;
    if(!from || from===to) continue;
    const k=from+'\u0000'+to+'\u0000'+l.grade;
    if(seen.has(k)) continue;
    seen.add(k);
    out.push({ from, to, grade:l.grade, observed:l.observed && from===l.from && to===l.to });
  }
  return out;
}
/** One lane: its heading and counts, then its rows by hop and band, folded when long. */
function laneColumn(v, lane, rows, tf, a, keep){
  const fit=laneWidth(rows.map((r)=> (v.labels.get(r.id)||{}).text||r.id));
  v.perLine=fit.perLine;
  const fold=foldLane(rows, { keep, open:v.open, lane:lane.field||'entry' });
  for(const [k,p] of fold.proxy) v.proxy.set(k,p);
  const box=el('div',{className:'fcol', style:'width:'+fit.width+'px'});
  box.dataset.field=lane.field||'entry';
  box.append(laneHead(v, lane, rows.length, fold.shown, lane.field ? tf[lane.field] : null));
  const keys=[];
  v.colKeys.push(keys);
  if(!rows.length){ box.append(flowEmptyNote(v, a, lane.field)); return box; }
  let hop=null, band=null;
  for(const it of fold.items){
    if(lane.grouped && it.type!=='more'){
      const [h, b]=it.group.split('|');
      if(h!==hop){ hop=h; band=null; box.append(el('div',{className:'fhop',textContent:t('chain.hop',{n:h})})); }
      if(b!==band){ band=b; const div=laneBandDivider(lane.field, b, rows.filter((x)=> String(x.hop)===h && laneBand(x.grade)===b).length); if(div) box.append(div); }
    }
    box.append(it.type==='row' ? lane.mk(it.rows[0].x) : laneFoldRow(v, lane, it));
    keys.push(it.key);
  }
  return box;
}
/**
 * A candidate band inside a hop: the divider carries the band's own stroke and
 * says what the band IS, with the true count of rows in it, folded or not.
 */
function laneBandDivider(field, band, n){
  if(band==='SOUND_SET') return el('div',{className:'fdiv',
    textContent:t(field==='statements'?'chain.band.candidate.stmt':'chain.band.candidate',{n})});
  if(band==='HEURISTIC') return el('div',{className:'fdiv fheur',textContent:t('chain.band.heuristic',{n})});
  return null;
}
/**
 * A lane's heading: its name and the ONE number a glance wants, how many rows
 * the walk found. Under it, only when they differ, the three numbers a reader
 * has to keep apart: how many are drawn, how many this page has fetched, and
 * how many there are; and the button that fetches the next page.
 */
function laneHead(v, lane, fetched, shown, tf){
  const total=tf ? tf.total : fetched;
  const kids=[ el('div',{className:'fcolhead'},[ el('span',{className:'fcoltitle',textContent:t(lane.title)}),
    el('span',{className:'count',title:t('chain.nums.title'),textContent:String(total)}) ]) ];
  if(shown<fetched || fetched<total){
    kids.push(el('div',{className:'fcolsub'},[
      el('span',{className:'count',textContent:t('chain.nums',{shown, fetched, total})}),
      // A saved file holds one answer and can ask for no page of it.
      (tf && tf.nextOffset!=null && !SNAP) ? el('button',{className:'moreb',
        textContent:t('chain.more.fetch',{n:Math.min(CHAIN_PAGE, total-fetched)}),
        title:t('chain.more.fetch.title',{order:tf.order}), onclick:()=>laneFetchMore(v, lane.field)}) : null ]));
  }
  return el('div',{className:'fcolhd'}, kids);
}
// The kind a lane's rows are, for the hop chip's colour.
const LANE_KIND={ services:'service', statements:'statement', tables:'table', endpoints:'endpoint', webFunctions:'webfn', screens:'screen' };
/**
 * A FOLDED ITEM: one owner's rows inside one hop and grade ("HomeServiceImpl,
 * 5 rows"), or the lane's "N more". It opens in place; its lines are the lines
 * of every row inside it, so a hover on it still lights where they go.
 */
function laneFoldRow(v, lane, it){
  const n=it.rows.length, more=it.type==='more';
  const band=more ? null : it.group.split('|')[1];
  const name=more ? t('chain.fold.more',{n}) : String(it.owner||'');
  const e=el('div',{className:'frow ffold'+(more?' fmore':''), tabIndex:0,
    title:t(more?'chain.fold.more.title':'chain.fold.group.title',{n, owner:name})},[
    el('div',{className:'frowtop'},[ el('span',{className:'fchev',textContent:'▸'}),
      el('span',{className:'fname'}, fitLines(name, v.perLine||CHAIN_FIT_PERLINE).map((l)=> el('span',{className:'fline',textContent:l}))) ]),
    el('div',{className:'fmeta'},[ more ? null : hopChip(LANE_KIND[lane.field]||'service', it.rows[0].hop),
      (band && LANE_BANDS.includes(band)) ? badge(band) : null,
      el('span',{className:'count',textContent:t(more?'chain.fold.more.what':'chain.fold.group.what',{n})}) ]) ]);
  e.setAttribute('role','button');
  e.setAttribute('aria-expanded','false');
  const toggle=()=> laneToggle(v, it.key);
  e.addEventListener('click', toggle);
  e.addEventListener('keydown',(ev)=>{ if(ev.key==='Enter'||ev.key===' '){ if(ev.preventDefault) ev.preventDefault(); toggle(); } else laneKeyNav(v, it.key, ev); });
  e.addEventListener('mouseenter',()=>flowHover(v, it.key));
  e.addEventListener('focus',()=>flowHover(v, it.key));
  e.addEventListener('blur',()=>flowClearHover(v));
  if(it.rows.some((r)=> v.found && v.found.has(r.key))) e.classList.add('found');
  v.rows.set(it.key,{ els:[e], kind:'fold', grade:band, data:{ rows:it.rows.map((r)=> r.key) } });
  return e;
}
/** Open or close one folded item, in place: the scroll and the selection stay. */
function laneToggle(v, key){
  if(v.open.has(key)) v.open.delete(key); else v.open.add(key);
  laneRerender(v);
}
/** Draw the same answer again without losing where the reader was in it. */
function laneRerender(v){
  if(!v.resp) return;
  const box=vwrap(v).parentNode;
  const top=box ? box.scrollTop : 0, left=box ? box.scrollLeft : 0;
  renderChain(v, v.resp);
  if(box){ box.scrollTop=top; box.scrollLeft=left; }
}
/** Does the chain through `key` run through a row this picture folded away? */
function laneChainFolded(v, key){
  if(!v.model || !v.proxy) return false;
  for(const k of chainThrough(v.model.links, key)) if(v.proxy.has(k) && v.proxy.get(k)!==k) return true;
  return false;
}
/** Everything a lane view holds about ONE answer's picture, forgotten. */
function laneReset(v){
  v.open.clear(); v.find=''; v.found=new Set(); v.model=null; v.proxy=new Map(); v.colKeys=[];
  const strip=byId(v.name+'strip');
  if(strip) strip.classList.add('hidden');
  if(v.findEl) v.findEl.value='';
  vwrap(v).classList.remove('lanesmode');
}
/**
 * FETCH THE NEXT PAGE OF ONE LANE (RM67). `flow` pages a lane by `offset`: the
 * rows come back in the walk's own order, so the page appends them to the lane
 * the reader asked about and draws again. The export then asks for as many
 * rows as are on screen, as far as one answer carries (200).
 */
async function laneFetchMore(v, field){
  const tf=((v.resp && v.resp.truncated && v.resp.truncated.fields)||[]).find((f)=> f.field===field);
  if(!tf || tf.nextOffset==null) return;
  const mine=v.seq;
  let r;
  try{ r=await api('flow', {...v.args, offset:tf.nextOffset, limit:CHAIN_PAGE}); }
  catch(e){ if(stale(e)||mine!==v.seq) return; vside(v).prepend(errPanel(e)); return; }
  if(mine!==v.seq) return;
  const have=new Set((v.resp.answer[field]||[]).map((x)=> fkey(x, laneNodeId(field, x))));
  const got=(r.answer[field]||[]).filter((x)=> !have.has(fkey(x, laneNodeId(field, x))));
  v.resp.answer[field]=[...(v.resp.answer[field]||[]), ...got];
  const nf=((r.truncated && r.truncated.fields)||[]).find((f)=> f.field===field);
  tf.shown=v.resp.answer[field].length;
  tf.total=nf ? nf.total : tf.total;
  tf.nextOffset=(nf && nf.nextOffset!=null && got.length) ? nf.nextOffset : null;
  v.resp.truncated.any=v.resp.truncated.fields.some((f)=> f.nextOffset!=null);
  v.args={...v.args, limit:Math.min(200, Math.max(v.args.limit||CHAIN_PAGE, tf.shown))};
  laneRerender(v);
}
/**
 * THE STRIP OVER THE PICTURE. It does not scroll away, sideways or down: the
 * start of the chain, every lane with its count (a click brings that lane into
 * view), and a box that finds a row by name and unfolds whatever hides it.
 */
function laneStrip(v, m, tf){
  const strip=byId(v.name+'strip');
  if(!strip) return;
  strip.classList.remove('hidden');
  if(!v.findEl) v.findEl=laneFindBox(v);
  const e=m.lanes[0].rows[0];
  const info=el('div',{className:'fstripinfo'},[
    el('span',{className:'fstripstart', title:String(e.id)},[ kindGlyph((e.x&&e.x.kind)||'table', 12),
      el('span',{className:'fstripname', textContent:(m.labels.get(e.id)||{}).text||e.id}) ]),
    ...m.lanes.slice(1).map((l)=> el('button',{className:'fstripchip', title:t('chain.strip.jump'), onclick:()=>laneJump(v, l.field)},[
      el('span',{textContent:t(l.title)}), ' ', el('span',{className:'count',textContent:String(tf[l.field] ? tf[l.field].total : l.rows.length)}) ])) ]);
  const found=el('span',{className:'count fstripfound',textContent: v.find ? t('chain.find.count',{n:(v.found||new Set()).size}) : ''});
  strip.replaceChildren(info, v.findEl, found);
}
/** Bring one lane into view inside the picture, not the page. */
function laneJump(v, field){
  const col=[...vwrap(v).children].find((c)=> c.dataset && c.dataset.field===field);
  if(col && col.scrollIntoView) col.scrollIntoView({block:'nearest', inline:'start'});
}
/** The find box: typing finds rows by name or id; Enter goes to the next; Escape clears it. */
function laneFindBox(v){
  const box=el('input',{type:'search', className:'fstripfind', placeholder:t('chain.find.ph'), title:t('chain.find.title')});
  box.setAttribute('data-t-ph','chain.find.ph');
  box.setAttribute('data-t-title','chain.find.title');
  let timer=null, at=0;
  box.addEventListener('input',()=>{ clearTimeout(timer); timer=setTimeout(()=>{ v.find=box.value; at=0; laneRerender(v); laneShowFound(v, 0); }, 200); });
  box.addEventListener('keydown',(ev)=>{
    if(ev.key==='Enter'){ at+=1; laneShowFound(v, at); }
    else if(ev.key==='Escape' && box.value){ if(ev.stopPropagation) ev.stopPropagation(); box.value=''; v.find=''; laneRerender(v); }
  });
  return box;
}
/** Scroll the n-th row the find box found into view, inside the picture. */
function laneShowFound(v, n){
  const keys=[...(v.found||[])].filter((k)=> v.rows.has(k));
  if(!keys.length) return;
  const key=keys[n % keys.length];
  const row=v.rows.get(key).els[0];
  if(row && row.scrollIntoView) row.scrollIntoView({block:'center', inline:'nearest'});
  flowHover(v, key);
}
/**
 * THE ARROWS WALK THE PICTURE. Up and down a lane; left and right to the next
 * lane, onto the row this one links to when there is one, else onto the row at
 * the same height. Focus lights the chain, as the pointer does, and Enter picks
 * it (flowMakeRow).
 */
function laneKeyNav(v, key, ev){
  const step={ ArrowUp:[0,-1], ArrowDown:[0,1], ArrowLeft:[-1,0], ArrowRight:[1,0] }[ev.key];
  if(!step || !v.colKeys || v.view!=='lanes') return;
  const ci=v.colKeys.findIndex((c)=> c.includes(key));
  if(ci<0) return;
  const ri=v.colKeys[ci].indexOf(key);
  let next=step[1] ? v.colKeys[ci][ri+step[1]] : null;
  for(let c=ci+step[0]; step[0] && !next && c>=0 && c<v.colKeys.length; c+=step[0]){
    const col=v.colKeys[c];
    if(!col.length) continue;
    const linked=col.find((k)=> v.linkSpecs.some((l)=> (l.from===key && l.to===k) || (l.to===key && l.from===k)));
    next=linked || col[Math.min(col.length-1, Math.round(ri*col.length/Math.max(1, v.colKeys[ci].length)))];
  }
  if(!next || !v.rows.has(next)) return;
  if(ev.preventDefault) ev.preventDefault();
  const e=v.rows.get(next).els[0];
  if(e && e.focus) e.focus();
}
