// 10_dom.js — the elements, the words and the small pieces every tab draws with.
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.

const el = (t, props={}, kids=[]) => { const e=document.createElement(t); Object.assign(e, props); for(const k of [].concat(kids)) if(k!=null) e.append(k); return e; };
// replaceChildren stringifies a null child into the text "null"; conditional
// panels are absent, not the word null. Drop the empty slots first.
const setKids = (node, ...kids) => node.replaceChildren(...kids.filter(k=>k!=null));
const svgEl = (t, attrs={}) => { const e=document.createElementNS('http://www.w3.org/2000/svg', t); for(const k in attrs) e.setAttribute(k, attrs[k]); return e; };
/** One kind as a filled dot, for a legend or a chip beside the pictures. */
function kindDot(kind, size){
  const s=size||12, r=s/2;
  const svg=svgEl('svg',{class:'kglyph', width:s, height:s, viewBox:'0 0 '+s+' '+s, 'aria-hidden':'true'});
  svg.append(svgEl('circle',{cx:r, cy:r, r:r-2.2, fill:kindFill(kind)}));
  return svg;
}
/** One kind glyph as a small inline SVG, for a legend, a chip or a lane row. */
function kindGlyph(kind, size){
  const s=size||12, r=s/2, ink=kindColor(kind), g=KIND_GLYPH[kind]||'circ';
  const svg=svgEl('svg',{class:'kglyph', width:s, height:s, viewBox:'0 0 '+s+' '+s, 'aria-hidden':'true'});
  if(g==='ring') svg.append(svgEl('circle',{cx:r,cy:r,r:r-1.1,fill:'none',stroke:ink,'stroke-width':1.4}));
  else if(g==='tri') svg.append(svgEl('path',{d:'M'+(r-2.8)+','+(r-3.7)+'L'+(r+3.5)+','+r+'L'+(r-2.8)+','+(r+3.7)+'Z',fill:ink}));
  else if(g==='circ') svg.append(svgEl('circle',{cx:r,cy:r,r:2.9,fill:'none',stroke:ink,'stroke-width':1.4}));
  else if(g==='diam') svg.append(svgEl('path',{d:'M'+r+','+(r-3.9)+'L'+(r+3.9)+','+r+'L'+r+','+(r+3.9)+'L'+(r-3.9)+','+r+'Z',fill:ink}));
  else if(g==='rect') svg.append(svgEl('rect',{x:r-4.2,y:r-2.8,width:8.4,height:5.6,fill:'none',stroke:ink,'stroke-width':1.4}));
  else if(g==='win'){
    svg.append(svgEl('rect',{x:r-4.2,y:r-3.6,width:8.4,height:7.2,rx:1,fill:'none',stroke:ink,'stroke-width':1.4}));
    svg.append(svgEl('line',{x1:r-4.2,y1:r-1.4,x2:r+4.2,y2:r-1.4,stroke:ink,'stroke-width':1.2}));
  }
  else svg.append(svgEl('circle',{cx:r,cy:r,r:2,fill:ink}));
  return svg;
}
// ONE SHAPE ON THE PICTURES: a disc, filled in its kind's hue, with a hairline
// of the canvas ground around it so two discs that touch still read as two.
// `k` is the zoom, so every stroke stays one screen pixel wide at any scale.
// `lit` adds the outline and (where the theme has one) the glow the spotlight
// gives the chain being answered.
function gfDot(ctx, x, y, r, k, opts){
  const o=opts||{}, col=o.color||'#888';
  ctx.save();
  if(o.lit && o.glow && themeGlows()){ ctx.shadowColor=col; ctx.shadowBlur=9/k; }
  ctx.beginPath(); ctx.arc(x, y, Math.max(0.6, r), 0, 2*Math.PI);
  ctx.fillStyle=col; ctx.fill();
  ctx.shadowBlur=0;
  // The separator ring is the GROUND, not ink: it is what parts two discs that
  // have settled against each other, and it must not read as a stroke of its
  // own. The lit ring on top of it is ink and does.
  ctx.lineWidth=1.5/k; ctx.strokeStyle=o.ground||cssVar('--g1'); ctx.stroke();
  if(o.lit){
    ctx.beginPath(); ctx.arc(x, y, Math.max(0.6, r)+2.2/k, 0, 2*Math.PI);
    ctx.lineWidth=1.6/k; ctx.strokeStyle=col; ctx.stroke();
  }
  ctx.restore();
}
/** The same six symbols on a canvas. `k` is the zoom, so a stroke stays one
 *  screen pixel wide at every scale; `filled` is what marks a lit node. */
function gfGlyph(ctx, kind, x, y, r, k, opts){
  const o=opts||{}, g=KIND_GLYPH[kind]||'circ';
  const col=o.color||kindColor(kind);
  ctx.strokeStyle=col; ctx.fillStyle=col;
  // A LIT node glows in the signal theme — the canvas equivalent of `--glow`.
  // Nothing glows at rest, and nothing glows at all where the token says none.
  if(o.filled && o.glow && themeGlows()){ ctx.shadowColor=col; ctx.shadowBlur=9/k; }
  ctx.lineWidth=(o.lineWidth||1.4)/k;
  ctx.beginPath();
  if(g==='ring'){
    ctx.arc(x,y,r,0,2*Math.PI); ctx.stroke();
    if(o.filled){ ctx.beginPath(); ctx.arc(x,y,Math.max(1,r-3/k),0,2*Math.PI); ctx.fill(); }
  } else if(g==='tri'){
    const a=r*1.15; ctx.moveTo(x-a*0.75,y-a*0.9); ctx.lineTo(x+a,y); ctx.lineTo(x-a*0.75,y+a*0.9); ctx.closePath();
    if(o.filled) ctx.fill(); else ctx.stroke();
  } else if(g==='diam'){
    const a=r*1.3; ctx.moveTo(x,y-a); ctx.lineTo(x+a,y); ctx.lineTo(x,y+a); ctx.lineTo(x-a,y); ctx.closePath();
    if(o.filled) ctx.fill(); else ctx.stroke();
  } else if(g==='rect'){
    const w=r*1.5, h=w*2/3; ctx.rect(x-w,y-h,2*w,2*h);
    if(o.filled) ctx.fill(); else ctx.stroke();
  } else if(g==='dot'){
    ctx.arc(x,y,Math.max(1.1,r*0.75),0,2*Math.PI); ctx.fill();
  } else {
    ctx.arc(x,y,r,0,2*Math.PI); if(o.filled) ctx.fill(); else ctx.stroke();
  }
  // The glow belongs to the GLYPH, never to the name drawn next to it.
  ctx.shadowBlur=0;
}
// A grade chip: the grade's name in Mono inside a 2px box drawn with that
// grade's own stroke. Four of the five boxes are a CSS border; dash-dot is not
// a border-style any browser has, so HEURISTIC carries an SVG rect instead.
function badge(g){
  const kids=[];
  if(g==='HEURISTIC'){
    const box=svgEl('svg',{class:'gbox'});
    box.append(svgEl('rect',{x:0.75, y:0.75, width:'100%', height:'100%', rx:2, fill:'none',
      stroke:cssVar('--t1'), 'stroke-width':1.5, 'stroke-dasharray':GRADE_DASH.HEURISTIC}));
    kids.push(box);
  }
  kids.push(g);
  return el('span',{className:'grade g-'+g}, kids);
}




const I18N={ lang:'en', catalog:{ en: VIEWER_STRINGS.en }, t: makeT(VIEWER_STRINGS,'en') };
const t=(key,params)=> I18N.t(key,params);
// A catalogue string's `code` / **bold** runs, as elements — never innerHTML.
const richNodes=(text)=> richText(text).map((x)=> x.tag ? el(x.tag,{textContent:x.text}) : x.text);
// Each language names ITSELF, out of its own catalogue: the toggle reads
// its own name, whatever language the page is currently in. A catalogue that did
// not load has no name to give, so its own code stands in.
const langLabel=(code)=> (I18N.catalog[code] && typeof I18N.catalog[code]['lang.label']==='string')
  ? I18N.catalog[code]['lang.label'] : code.toUpperCase();
// ---------- the fold: GLANCE, then READ, then INSPECT ------------------------
// Three levels, everywhere on this page. GLANCE is a number, a chip, a glyph or
// the picture — no sentences. READ is one line. INSPECT is the full text, and
// the READER opens it: never the page, never on load.
//
// NOTHING IS DELETED BY A FOLD. The body holds exactly the words this page used
// to print, one activation away, and every count stays outside it. The open /
// closed state lives in localStorage under the fold's own key, which is what
// lets a language switch — which rebuilds these blocks out of the catalogue —
// put each of them back the way the reader left it.
const LS_FOLD='cascade.viewer.fold.';
const foldIsOpen=(key)=> lsGet(LS_FOLD+key)==='1';
const foldSetOpen=(key,open)=> lsSet(LS_FOLD+key, open?'1':'0');
// The chevron: a drawn stroke in ink, not an arrow CHARACTER. A character would
// come out of whatever font the reader has, at whatever weight, and it would be
// read aloud — this is `aria-hidden`, and the button says `aria-expanded`.
function foldChevron(){
  const s=svgEl('svg',{class:'foldchev', width:8, height:8, viewBox:'0 0 8 8',
    'aria-hidden':'true', focusable:'false'});
  s.append(svgEl('path',{d:'M2.5 1 L6 4 L2.5 7', fill:'none', stroke:'currentColor',
    'stroke-width':1.4, 'stroke-linecap':'round', 'stroke-linejoin':'round'}));
  return s;
}
/**
 * The lead button and the body, as two nodes the caller places itself — the
 * evidence rail puts its leads in a row of chips and their bodies underneath.
 * `bodyBuilder` runs ONCE, on the first open: a body nobody asked for is never
 * built, so a closed fold costs no DOM either.
 */
function foldParts(key, lead, bodyBuilder, leadClass, eager){
  const head=el('button',{type:'button', className:'foldlead'+(leadClass?' '+leadClass:'')},
    [ foldChevron(), el('span',{className:'foldtext'}, [].concat(lead).filter((x)=>x!=null)) ]);
  const body=el('div',{className:'foldbody'});
  let built=false;
  const build=()=>{ built=true; body.append(...[].concat(bodyBuilder()).filter((x)=>x!=null)); };
  const paint=(open)=>{
    if(open && !built) build();
    head.classList.toggle('open', open);
    body.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    head.setAttribute('aria-label', t(open?'fold.hide':'fold.show'));
  };
  // A <button> already answers Enter and Space; nothing here re-implements them.
  head.onclick=()=>{ const open=!foldIsOpen(key); foldSetOpen(key, open); paint(open); };
  paint(foldIsOpen(key));
  // `eager` is for a fold that is itself INSIDE another fold's body: opening the
  // outer one has to put the whole text in the document, or the honesty contract
  // ("every full text is one activation away") would quietly become two.
  if(eager && !built) build();
  return [head, body];
}
function fold(key, lead, bodyBuilder, leadClass, eager){
  return el('div',{className:'fold'}, foldParts(key, lead, bodyBuilder, leadClass, eager));
}
// The first sentence of a note the ENGINE wrote, or its first 90 characters —
// whichever comes first. The words are the engine's and are not rewritten; only
// the CUT is the page's, and the full text is under the fold this lead opens.
function leadOf(text){
  const s=String(text).trim();
  const m=s.match(/^[^.!?]*[.!?](?=\s|$)/);
  const first=(m && m[0].length<=90) ? m[0] : s;
  if(first.length<=90) return first;
  return s.slice(0,89).replace(/\s+\S*$/,'')+'…';
}

// THE EVIDENCE RAIL. The same block sits beside every answer on every tab, in
// the same place: what this answer RESTS ON, in four sections — basis, trust,
// limits, truncated. Only the HEADING is the page's own words. The field labels
// under it name the engine's own contract fields and stay in the engine's
// language beside the engine's values: a translated field name would be a field
// this page invented, and no reader could check it against the answer.
//
// COLLAPSED it is one line of chips — the trust level, the freshness verdict,
// how many limits there are, and every field the answer truncated with its own
// shown/total. Those are the COUNTS, and they never fold: what folds is the
// sentences. `scope` names which answer this rail is beside, so two rails on
// two tabs remember their own open blocks.
function honesty(resp, scope) {
  const k = 'rail.'+(scope||'x');
  const b = resp.basis||{}, tt = resp.trust||{}, tr = resp.truncated||{};
  const row=(label,v)=> (v==null||v==='') ? null
    : el('div',{className:'railrow'},[ el('span',{textContent:label}), el('span',{textContent:String(v)}) ]);
  const chip=(text,title)=> el('span',{className:'railchip', title:title||'', textContent:text});
  // GLANCE. The trust level and the freshness verdict are the engine's own
  // words and are printed as they arrived, here and in the folds below.
  const chips=el('div',{className:'railchips'},[
    chip(tt.trustLevel||'trust unknown', 'trust.trustLevel'),
    chip('freshness '+((b.freshness&&b.freshness.verdict)||'unknown'), 'basis.freshness.verdict'),
  ]);
  const bodies=[];
  const lim=resp.limits||[];
  if(lim.length){
    const [head, body]=foldParts(k+'.limits', [lim.length+' limits'],
      ()=> lim.map((l,i)=> railLimit(k+'.lim.'+i, l)), 'railchip');
    chips.append(head); bodies.push(body);
  }
  // A truncation is a count, so it stays outside every fold: one chip per field
  // the answer cut, carrying that field's own name and its shown/total.
  const cut=(tr.fields||[]).filter((f)=>f.nextOffset!=null);
  if(tr.any && cut.length){
    chips.append(el('span',{className:'raillbl', style:'margin:0 1px', textContent:'truncated'}));
    for(const f of cut) chips.append(chip(f.field+' '+f.shown+'/'+f.total, 'order: '+f.order));
  }
  // READ / INSPECT. `basis` and `trust` are the engine's contract sections and
  // keep their field names; the masthead's title block already prints the
  // project, the digest, the lanes and the base commit beside the page.
  const folds=el('div',{className:'railfolds'},[
    fold(k+'.basis', ['basis'], ()=> [
      row('project', b.project),
      row('digest', b.buildDigest),
      row('built', b.builtAt ? String(b.builtAt).replace('T',' ').replace(/\..*$/,'') : null),
      row('freshness', (b.freshness&&b.freshness.verdict)||'unknown'),
    ].filter(Boolean)),
    fold(k+'.trust', ['trust'], ()=> [
      row('level', tt.trustLevel||'—'),
      row('axes', (tt.axes||[]).join(', ')||'—'),
      (tt.gatesNotShown||[]).length ? row('gates not shown', tt.gatesNotShown.join(', ')) : null,
    ].filter(Boolean)),
  ]);
  // THE GRADE LEGEND lives here now, in the header of the block that is about
  // what an answer rests on — which is where a reader asks what a grade means.
  // It was a fourth line of the masthead, above every tab, whether or not the
  // tab under it drew a graded thing.
  return el('div',{className:'rail'},[
    el('div',{className:'railhead'},[
      el('h2',{textContent:t('rail.rests')}),
      el('span',{className:'legend'},[t('legend.grade')+' ', ...GRADES.map(badge)]) ]),
    chips, ...bodies, folds ]);
}
// One limit: its scope chip, then a one-line lead cut from the engine's own
// reason, folding to that reason in full. A reason short enough to be its own
// lead is simply printed — a fold over nothing is a click that buys nothing.
function railLimit(key, l){
  const reason = l.reason || JSON.stringify(l);
  const scope = l.scope ? el('span',{className:'scope',textContent:l.scope+'  '}) : null;
  const lead = leadOf(reason);
  if(lead===reason) return el('div',{className:'raillim plain'}, [scope, reason].filter(Boolean));
  return el('div',{className:'raillim'},[
    fold(key, [scope, lead].filter(Boolean), ()=> [el('div',{className:'comment'},[reason])], null, true) ]);
}
// The engine's own word for "there is nothing here", as a sentence. Kept apart
// from the <li> below it so a ruled TABLE can print the same reason in a cell.
function emptyText(reasonMap, field) {
  const r = reasonMap && reasonMap[field];
  return r==='not-shipped' ? t('empty.notshipped')
    : r==='none' ? t('empty.none')
    : r==='not-in-this-axis' ? t('empty.notinaxis') : t('empty.none');
}
function emptyNote(reasonMap, field) {
  return el('li',{className:'empty', textContent:emptyText(reasonMap, field)});
}
// A ruled table: hairlines, no cards, every number in Mono. `heads` are
// {label, num} (num = right-aligned tabular figures).
function ruled(heads, rows){
  return el('table',{className:'ruled'},[
    el('thead',{},[ el('tr',{}, heads.map((h)=> el('th',{className:h.num?'num':'', textContent:h.label}))) ]),
    el('tbody',{}, rows) ]);
}
/**
 * A ROUTE'S NAME ON A LIST, with the chip that says which project serves it.
 *
 * The chip is drawn only on a federated row, so a row of this project's own
 * keeps exactly the DOM it always had. It sits AFTER the name and shrinks
 * before the name does, the same rule the lane rows follow.
 */
function epName(row, name){
  if(!row || !row.project) return name;
  return el('span',{style:'display:flex;align-items:center;gap:6px;min-width:0'},[name, projTag(row)]);
}
function listPanel(title, total, items, render, emptyReasons, emptyField) {
  const ul = el('ul',{className:'list'});
  if (!items.length) ul.append(emptyNote(emptyReasons, emptyField));
  else for (const it of items) ul.append(render(it));
  return el('div',{className:'panel'}, [el('h2',{}, [title+' ', el('span',{className:'count', textContent: total!=null?`(${total})`:''})]), ul]);
}
const byId=(id)=>document.getElementById(id);
const vwrap=(v)=>byId(v.wrapId), vside=(v)=>byId(v.sideId), vsvg=(v)=>vwrap(v).querySelector('svg.flowsvg');
