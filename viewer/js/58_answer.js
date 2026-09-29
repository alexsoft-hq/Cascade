// 58_answer.js — Trace's answer in one sentence, and the ends a reader came for, over the picture (RM67-U2e).
//
// ONE of the page's scripts, and they share ONE global scope: the numbers in the
// file names are the order the browser runs them in (see the tags at the foot of
// viewer/index.html), and a name declared in an earlier file is a name every
// later file can use. Nothing here is a module and nothing is exported; this is
// the same single scope the page always had, said in files a reader can find
// their way around and a linter can read.
//
// WHAT A READER CAME FOR. "If I change pms_product.name, what breaks?" has an
// answer of two numbers, the APIs and the screens at the end of the walk up. The
// picture put them in its last two lanes, past the right edge of the pane at
// 1100 and 1440, and the strip over it named them in five small chips a reader
// had to add up. Now the answer is said first, in one sentence with the mode and
// depth it was counted in, and the ends are listed under it, so the columns a
// business reader wants are on screen before anything is scrolled. The picture
// stays below as the evidence. Every number is the answer's own: a lane's total
// from `truncated`, the mode and depth from `walk`.
//
// WHEN THE MODE STOPS THE WALK AT THE START, the sentence says that instead, in
// one line, with the wider mode as a button: the three empty lanes used to say
// the same thing three times.

// The lanes that answer the question, by direction: up, the APIs and the screens
// a change is felt on; down, the SQL and the tables a call ends at, or from a
// screen, the APIs it calls and the tables they reach.
const ANSWER_ENDS = { up:['endpoints', 'screens'], down:['statements', 'tables'], screen:['endpoints', 'tables'] };
// What one end is called in the sentence: [many, one], spelled out so the
// catalogue tests can see each key (English counts one apart; Korean does not).
const ANSWER_UNIT = { endpoints:['trace.ans.endpoints', 'trace.ans.endpoints.one'], screens:['trace.ans.screens', 'trace.ans.screens.one'],
  statements:['trace.ans.statements', 'trace.ans.statements.one'], tables:['trace.ans.tables', 'trace.ans.tables.one'] };
// How many names each end lists before "and n more in the picture".
const ANSWER_ROWS = 5;

/** A counted phrase from a [many, one] pair of keys. */
function tn(keys, n, params){
  return t(n===1 ? keys[1] : keys[0], { n:ovNum(n), ...(params||{}) });
}
/**
 * The end lanes this answer has, in the order the sentence says them. A page a
 * route renders on the server calls no API: its handler hangs under it, so
 * walked down it ends at the SQL and the tables like a route does.
 */
function answerEnds(v, a){
  const e=a.entry || {}, page=e.kind==='screen' && !(a.endpoints || []).length && (a.services || []).length>0;
  const want=v.direction==='up' ? ANSWER_ENDS.up : (e.kind==='screen' && !page ? ANSWER_ENDS.screen : ANSWER_ENDS.down);
  // A route walked up is the API itself: "0 APIs" would count it out, so an
  // empty lane of the start's own kind is not an end.
  const own={ endpoint:'endpoints', screen:'screens' }[e.kind];
  return want.filter((f)=> Array.isArray(a[f]) && !(f===own && !a[f].length));
}
/** A lane's whole count: what `truncated` says there is, else the rows that came. */
function answerCount(r, field){
  const f=((r.truncated && r.truncated.fields) || []).find((x)=> x.field===field);
  return f ? f.total : (r.answer[field] || []).length;
}
/** Is the answer on the Trace place the one for the question on its controls' target and direction? */
function answerIsCurrent(v){
  return !!(v.resp && TRACE.target && TRACE.dir!=='detail' && v.respRaw===TRACE.target.kind+':'+TRACE.target.id+'|'+TRACE.dir);
}

/**
 * THE ANSWER LINE over the picture: the sentence, what it was counted in, and,
 * where the depth cut it, that there may be more and the button that follows
 * it all the way. Null while no answer for this question is in.
 */
function traceAnswerLine(v){
  if(!answerIsCurrent(v)) return null;
  const r=v.resp, a=r.answer, w=a.walk || {}, cut=w.cut || {};
  const ends=answerEnds(v, a), counts=ends.map((f)=> answerCount(r, f));
  const floor=cut.byMode>0 && counts.every((n)=> n===0);
  if(floor) return answerFloorLine(v, r);
  const parts=ends.map((f, i)=> tn(ANSWER_UNIT[f], counts[i])).join(t('trace.ans.and'));
  const say=counts.some((n)=> n>0) ? t(v.direction==='up' ? 'trace.ans.up' : 'trace.ans.down', { parts }) : t('trace.ans.none', { parts });
  const deeper=cut.depth>0 && w.depth!=null;
  return el('div',{className:'tanswer'},[
    el('b',{className:'tanswersay',textContent:say}),
    el('span',{className:'tanswermode',textContent:t('trace.ans.mode',{ mode:w.mode, depth:depthText(w.depth) })}),
    deeper ? el('span',{className:'tanswercut',textContent:t('trace.ans.cut',{ depth:w.depth })}) : null,
    deeper ? traceDeeperButton(w) : null, answerAddressCaveat(v, a), answerModeZero(v, r, ends, counts) ]);
}
/**
 * AN END THAT READS 0 IN THIS MODE, while the mode left links out: "0 screens"
 * there is this mode's count, not "no screen is affected". Said beside it, with
 * the wider mode as a button (on mall, the frontend's calls are HEURISTIC since
 * the web lane stopped taking an unstated port as settled, and conservative
 * reaches no screen).
 */
function answerModeZero(v, r, ends, counts){
  const w=r.answer.walk || {}, cut=w.cut || {};
  const zero=ends.filter((f, i)=> counts[i]===0);
  const wider=cut.byMode>0 && zero.length ? chainWiderMode(w.mode, cut.byModeGrades || {}) : null;
  if(!wider) return null;
  const what=zero.map((f)=> tn(ANSWER_UNIT[f], 0)).join(t('trace.ans.and'));
  return el('span',{className:'tanswercut'},[ t('trace.ans.zero',{ what, mode:w.mode, n:ovNum(cut.byMode) }), ' ',
    el('button',{type:'button', className:'mini tmodebtn', textContent:t('trace.ans.look',{ mode:wider }),
      onclick:()=>{ byId(v.modeId).value=wider; traceAsk(); }}) ]);
}
/**
 * A ROUTE WHOSE OWN ADDRESS IS A GUESS, walked up: every caller was matched to it
 * by that address, so each carries its grade (J4). Said beside the answer, in the
 * page's words, with the route's grade.
 */
function answerAddressCaveat(v, a){
  const e=a.entry || {};
  if(v.direction!=='up' || e.kind!=='endpoint' || !e.grade || ['EXACT', 'SOUND_SET'].includes(e.grade)) return null;
  return el('span',{className:'tanswercut',textContent:t('trace.ans.address',{ grade:e.grade })});
}
/**
 * NOTHING REACHED, BECAUSE OF THE MODE: said once, with why and the wider mode
 * as a button. A route whose own address is graded below the floor is the
 * usual cause, and says so; otherwise, how many links the mode did not follow.
 */
function answerFloorLine(v, r){
  const a=r.answer, w=a.walk || {}, cut=w.cut || {}, e=a.entry || {};
  // Walked down, a route's link to its handler is the first step; walked up it is
  // not a step at all, so only down can a route stop the walk at itself.
  const stopped=v.direction==='down' && e.kind==='endpoint' && e.grade && !(MODE_ADMITS[w.mode] || []).includes(e.grade);
  const wider=chainWiderMode(w.mode, cut.byModeGrades || {});
  const say=stopped ? t('trace.ans.floor.route', { mode:w.mode, grade:e.grade })
    : t('trace.ans.floor', { mode:w.mode, n:ovNum(cut.byMode) });
  return el('div',{className:'tanswer tfloor'},[
    el('b',{className:'tanswersay',textContent:say}),
    wider ? el('button',{type:'button', className:'mini tmodebtn', textContent:t('trace.ans.look',{ mode:wider }),
      onclick:()=>{ byId(v.modeId).value=wider; traceAsk(); }}) : el('span',{className:'tanswermode',textContent:t('chain.left.nomode')}) ]);
}
/**
 * THE ENDS, listed: one box per end lane with its count and its first names,
 * each a button that picks that row in the picture and brings it into view.
 * Absent while no answer is in, and when nothing was reached.
 */
function traceEndsBlock(v){
  if(!answerIsCurrent(v) || !v.model) return null;
  const ends=answerEnds(v, v.resp.answer).filter((f)=> answerCount(v.resp, f)>0);
  if(!ends.length) return null;
  return el('div',{className:'tends'}, ends.map((f)=> answerEndBox(v, f)));
}
function answerEndBox(v, field){
  const lane=v.model.lanes.find((l)=> l.field===field) || { rows:[] };
  const total=answerCount(v.resp, field), rows=lane.rows.slice(0, ANSWER_ROWS);
  const rest=total-rows.length;
  return el('div',{className:'tend'},[
    el('button',{type:'button', className:'tendhead', title:t('chain.strip.jump'), onclick:()=> laneJump(v, field)},[
      el('span',{textContent:laneTitle(field)}), ' ', el('span',{className:'count',textContent:ovNum(total)}) ]),
    ...rows.map((row)=> answerEndRow(v, row)),
    rest>0 ? el('div',{className:'count tendmore',textContent:t('trace.ans.more',{ n:ovNum(rest) })}) : null ]);
}
function answerEndRow(v, row){
  const text=(v.labels.get(row.id) || {}).text || row.id;
  return el('button',{type:'button', className:'tendrow psplit', title:String(row.id).slice(String(row.id).indexOf(':')+1),
    onclick:()=> answerShowRow(v, row.key)}, nameSplit(text));
}
/** Pick one end row in the picture, unfolding what hides it, and bring it into view inside the pane. */
function answerShowRow(v, key){
  if(v.sel!==key) flowSelect(v, key);
  const row=v.rows.get(key);
  const e=row && row.els[0];
  if(e && e.scrollIntoView) e.scrollIntoView({ block:'nearest', inline:'nearest' });
}

// ---- Start: the cause first, where nothing reaches ------------------------------
/**
 * WHERE THE MODE STOPS EVERY WALK AT THE START, Start says so before anything
 * else. On ghostfolio 117 of 118 routes have an address only a rule guessed,
 * conservative stops at every one of them, and the page opened on five cards
 * reading 0%, which reads as an analysis that failed. Now the first thing on
 * Start is the cause in one line, the engine's fix for it, and the wider mode
 * as a button that moves the map, the shares and the table and API rankings together
 * (startSetMode). Looking in another mode, the line says so, and the way back.
 */
function renderStartLead(a){
  const box=byId('slead');
  if(!box) return;
  const kids=START.mode ? startLeadLooking(a) : startLeadNothing(a);
  box.classList.toggle('hidden', !kids);
  setKids(box, ...(kids || []));
}
/** Does no route of this answer reach a SQL statement? */
function startNothingReaches(a){
  const rc=(a && a.reach) || {};
  return rc.endpoints>0 && (rc.endpointsWithoutStatement || 0)>=rc.endpoints;
}
/** The routes graded below this mode's floor, as {grade: n}; empty when the mode walks every route it has. */
function startRoutesBelow(a){
  const rg=(a.reach && a.reach.routeGrades) || {}, admits=MODE_ADMITS[a.mode] || [];
  return Object.fromEntries(Object.entries(rg).filter(([g, n])=> n>0 && !admits.includes(g)));
}
/** Does the lead line carry the route cause? Then the gaps panel does not say it a second time. */
const startLeadHasRoutes=(a)=> !START.mode && startNothingReaches(a) && Object.keys(startRoutesBelow(a)).length>0;
function startLeadNothing(a){
  if(!startNothingReaches(a)) return null;
  const below=startRoutesBelow(a), routes=Object.keys(below).length>0;
  const wider=chainWiderMode(a.mode, below);
  return [ el('b',{className:'startleadsay',textContent: routes ? t('start.lead.routes', { say:ovRoutesGuessed(a) }) : t('start.lead.none', { mode:a.mode })}),
    routes ? remedyLine(a.routeRemedy) : null,
    wider ? el('button',{type:'button', className:'mini', textContent:t('trace.ans.look',{ mode:wider }), onclick:()=> startLook(wider)}) : null ];
}
function startLeadLooking(a){
  return [ el('b',{className:'startleadsay',textContent:t('start.lead.looking',{ mode:START.mode, from:a.mode })}),
    el('button',{type:'button', className:'mini', textContent:t('start.lead.back',{ mode:a.mode }), onclick:()=> startSetMode(a.mode)}) ];
}
/** Look in another mode, and bring the map it moves into view. */
function startLook(mode){
  startSetMode(mode);
  const m=byId('ovsummary');
  if(m && m.scrollIntoView) m.scrollIntoView({ block:'start' });
}
