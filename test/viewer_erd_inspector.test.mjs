import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootPage, settle, ev } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

const columns = (project) => Array.from({ length: 15 }, (_, i) => ({
  column: i === 0 ? 'very_long_primary_identifier_for_inspection' : `detail_column_${i}`,
  type: i === 0 ? 'DECIMAL(24, 8) UNSIGNED' : i === 8 ? 'TIMESTAMP WITH TIME ZONE' : 'VARCHAR(255)',
  comment: i === 0 ? `${project} complete primary key comment, preserved in full` : `${project} descriptive note ${i}`,
  pk: i === 0,
}));
const response = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const relation = (from, to) => ({ from, to, cardinality: '1:N', columns: [`${from}.id=${to}.id`], statements: 1 });

async function boot(t, { storage = {}, deferColumns = false } = {}) {
  const { html, base } = await startViewer(t, ['alpha', 'beta']);
  const pending = [];
  const answer = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    const res = await fetch(base + url, opts);
    if (body?.name !== 'erd') return res;
    const data = await res.json();
    if (body.arguments?.table) {
      data.answer.tables[0].columns = columns(body.project);
      if (deferColumns) return new Promise((resolve) => pending.push({ project: body.project, release: () => resolve(response(data)) }));
    } else {
      data.answer.tables = [{ table: 'alpha_order', columnCount: 15 }, { table: 'alpha_peer', columnCount: 1 }];
      data.answer.relationships = [relation('alpha_order', 'alpha_peer')];
      data.answer.federated = [{ project: 'beta', tables: [{ table: 'beta_invoice', columnCount: 15 }, { table: 'beta_peer', columnCount: 1 }],
        relationships: [relation('beta_invoice', 'beta_peer')], via: [] }];
    }
    return response(data);
  };
  const page = await bootPage({ html, hash: '#p=alpha&tab=erd', origin: base, answer, renderer: true,
    storage: { 'cascade.viewer.erdconnected': 'on', ...storage } });
  await settle(page.ctx, 15);
  return { ...page, pending };
}
const detailCalls = (page) => page.calls.filter((c) => c.body?.name === 'erd' && c.body.arguments?.table);
const table = (page) => page.byId.get('erdside').querySelector('table.erdcolumns');
const rows = (page) => table(page).querySelectorAll('tbody tr');
const filter = (page, query) => {
  const input = page.byId.get('erdside').querySelector('.erdcolfilter');
  input.value = query; input.oninput({ target: input });
};
const fire = (node, type, extra = {}) => {
  for (const fn of node._listeners.get(type) || []) fn({ target: node, preventDefault() {}, ...extra });
};
async function select(page, id = 'alpha_order') {
  ev(page.ctx, `erdSelect(${JSON.stringify(id)})`);
  await settle(page.ctx, 8);
}

for (const [label, id, project] of [['local', 'alpha_order', 'alpha'], ['federated', 'beta|beta_invoice', 'beta']]) {
  test(`the ${label} ERD inspector keeps more than twelve columns in one searchable semantic table`, async (t) => {
    const page = await boot(t);
    await select(page, id);
    const side = page.byId.get('erdside');
    assert.equal(side.querySelectorAll('table.erdcolumns').length, 1);
    const relations = side.querySelector('details.erdrelations');
    assert.ok(relations);
    assert.equal(relations.getAttribute('open'), null, 'relationship evidence starts collapsed');
    assert.match(relations.querySelector('summary').textContent, /relationships \(1\)/);
    assert.ok(relations.querySelectorAll('li').length > 0, 'the relationship evidence is present in the fold');
    assert.equal(table(page).closest('details'), null, 'the columns remain outside the relationship fold');
    assert.equal(table(page).getAttribute('aria-label'), 'columns');
    assert.equal(side.querySelector('.colgrid2'), null);
    assert.equal(rows(page).length, 15);
    assert.deepEqual(table(page).querySelectorAll('th').map((n) => n.textContent), ['Name', 'Type', 'Comment']);
    assert.ok(table(page).querySelectorAll('th').every((n) => n.getAttribute('scope') === 'col'));
    assert.equal(rows(page)[0].querySelector('.erdcolname .id').textContent, columns(project)[0].column);
    assert.equal(rows(page)[0].querySelector('.erdcoltype').textContent, columns(project)[0].type);
    assert.equal(rows(page)[0].querySelector('.erdcolcomment').textContent, columns(project)[0].comment);
    assert.equal(rows(page)[0].querySelector('.pk').title, 'Primary key');
    assert.equal(detailCalls(page).length, 1);
    assert.equal(detailCalls(page)[0].body.project, project);
    if (project === 'beta') assert.match(side.textContent, /asked of beta/);

    filter(page, 'timestamp');
    assert.equal(rows(page).length, 1);
    assert.equal(rows(page)[0].querySelector('.erdcolname .id').textContent, 'detail_column_8');
    filter(page, 'descriptive note 14');
    assert.equal(rows(page).length, 1, 'comments are searchable');
    filter(page, 'very_long_primary');
    assert.equal(rows(page).length, 1, 'names are searchable');
    assert.equal(rows(page)[0].querySelector('.pk').textContent, 'PK ');
    assert.equal(side.querySelector('.erdcolcount').textContent, '1 of 15');
    filter(page, 'nothing matches this');
    assert.equal(rows(page).length, 0);
    assert.equal(side.querySelector('.erdcolempty').classList.contains('hidden'), false);
    assert.match(side.querySelector('.erdcolempty').textContent, /Try a different name, type or comment/);
    filter(page, 'very_long_primary');
    const asked = page.calls.length;
    ev(page.ctx, "setLang('ko')");
    await settle(page.ctx, 8);
    assert.deepEqual(table(page).querySelectorAll('th').map((n) => n.textContent), ['이름', '타입', '설명']);
    assert.match(side.querySelector('.erdrelations summary').textContent, /관계 \(1\)/);
    assert.equal(side.querySelector('.erdcolfilter').value, 'very_long_primary');
    assert.equal(side.querySelector('.erdcolfilter').getAttribute('aria-label'), '컬럼 이름, 타입, 설명 검색');
    assert.equal(side.querySelector('.erdcolcount').textContent, '전체 15개 중 1개');
    assert.equal(rows(page)[0].querySelector('.pk').title, '기본 키');
    assert.equal(page.byId.get('erdwiden').textContent, '넓히기');
    assert.match(page.byId.get('erdgrab').getAttribute('aria-label'), /왼쪽으로 끌면 넓어집니다/);
    assert.equal(page.calls.length, asked, 'filtering and language changes reuse the cached columns');
  });
}

test('ERD inspector dragging and keyboard resizing preserve selection, cached columns, layout and camera', async (t) => {
  const page = await boot(t);
  await select(page);
  const { ctx, byId, store, fireDoc, fireWindow } = page;
  byId.get('erdgrid').clientWidth = 1400;
  byId.get('erdwrap').clientWidth = 830;
  byId.get('erdwrap').clientHeight = 650;
  const cell = rows(page)[0];
  const asked = page.calls.length;
  const layout = ev(ctx, 'JSON.stringify(ERD.nodes.map(n=>[n.id,n.x,n.y]))');
  ev(ctx, `globalThis.inspectorColsBefore=ERD.cols.get('alpha_order');
    ERD.api={ camera:1.75, width(w){this.w=w; return this;}, height(h){this.h=h; return this;} };
    erdInspectorApply();`);
  const grab = byId.get('erdgrab');
  assert.equal(grab.getAttribute('role'), 'separator');
  assert.equal(grab.getAttribute('aria-valuemin'), '360');
  assert.equal(grab.getAttribute('aria-valuemax'), '900');
  fire(grab, 'mousedown', { clientX: 900, button: 0 });
  fireDoc('mousemove', { clientX: 700 });
  assert.equal(grab.getAttribute('aria-valuenow'), '660', 'dragging left widens');
  fireDoc('mousemove', { clientX: 800 });
  assert.equal(grab.getAttribute('aria-valuenow'), '560', 'dragging right narrows');
  fireDoc('mouseup');
  fireDoc('mousemove', { clientX: 200 });
  assert.equal(store.get('cascade.viewer.erdw'), '560');
  fire(grab, 'keydown', { key: 'ArrowLeft' });
  assert.equal(store.get('cascade.viewer.erdw'), '592');
  fire(grab, 'keydown', { key: 'ArrowRight' });
  assert.equal(store.get('cascade.viewer.erdw'), '560');
  fire(grab, 'keydown', { key: 'End' });
  assert.equal(grab.getAttribute('aria-valuenow'), '900');
  fire(grab, 'keydown', { key: 'Home' });
  assert.equal(grab.getAttribute('aria-valuenow'), '460');
  assert.equal(ev(ctx, 'erdInspectorSetWidth(10)'), 360);
  assert.equal(ev(ctx, 'erdInspectorSetWidth(10000)'), 900);
  ev(ctx, 'erdInspectorSetWidth(600)');
  byId.get('erdwiden').click();
  assert.equal(grab.getAttribute('aria-valuenow'), '900');
  assert.equal(byId.get('erdwiden').getAttribute('aria-pressed'), 'true');
  byId.get('erdwiden').click();
  assert.equal(grab.getAttribute('aria-valuenow'), '600');
  assert.equal(byId.get('erdwiden').getAttribute('aria-pressed'), 'false');
  fire(grab, 'mousedown', { clientX: 900, button: 0 });
  fireWindow('blur');
  fireDoc('mousemove', { clientX: 500 });
  assert.equal(grab.getAttribute('aria-valuenow'), '600', 'blur ends the drag');
  fire(grab, 'dblclick');
  assert.equal(grab.getAttribute('aria-valuenow'), '460');
  ev(ctx, 'erdInspectorSetWidth(650)');
  byId.get('erdwidthreset').click();
  assert.equal(store.get('cascade.viewer.erdw'), '460');
  await settle(ctx, 5);
  assert.equal(ev(ctx, 'ERD.W'), 830);
  assert.equal(ev(ctx, 'ERD.H'), 650);
  assert.equal(ev(ctx, 'ERD.api.w'), 830);
  assert.equal(ev(ctx, 'ERD.api.h'), 650);
  assert.equal(ev(ctx, 'ERD.api.camera'), 1.75);
  assert.equal(ev(ctx, 'ERD.sel'), 'alpha_order');
  assert.equal(ev(ctx, 'ERD.cols.get("alpha_order")===inspectorColsBefore'), true);
  assert.equal(ev(ctx, 'JSON.stringify(ERD.nodes.map(n=>[n.id,n.x,n.y]))'), layout);
  assert.equal(rows(page)[0], cell, 'resizing does not recreate the details');
  assert.equal(page.calls.length, asked, 'resizing asks for no new answer');
});

test('ERD inspector width survives reload and temporary narrow or stacked layouts', async (t) => {
  const page = await boot(t, { storage: { 'cascade.viewer.erdw': '720' } });
  const { ctx, byId, store, fireWindow } = page;
  byId.get('erdgrid').clientWidth = 1400;
  ev(ctx, 'erdInspectorApply()');
  assert.equal(byId.get('erdgrab').getAttribute('aria-valuenow'), '720');
  byId.get('erdgrid').clientWidth = 800;
  ev(ctx, 'window.innerWidth=1050');
  fireWindow('resize');
  await settle(ctx, 30);
  assert.equal(byId.get('erdgrab').getAttribute('aria-valuemax'), '420');
  assert.equal(byId.get('erdgrab').getAttribute('aria-valuenow'), '420');
  assert.equal(store.get('cascade.viewer.erdw'), '720', 'responsive capping does not overwrite the preference');
  ev(ctx, 'window.innerWidth=900');
  fireWindow('resize');
  await settle(ctx, 30);
  assert.equal(byId.get('erdwiden').disabled, true);
  assert.equal(store.get('cascade.viewer.erdw'), '720');
  byId.get('erdgrid').clientWidth = 1400;
  byId.get('erdwrap').clientWidth = 950;
  ev(ctx, 'window.innerWidth=1400');
  fireWindow('resize');
  await settle(ctx, 30);
  assert.equal(byId.get('erdgrab').getAttribute('aria-valuenow'), '720');
  assert.equal(ev(ctx, 'ERD.W'), 950, 'window resizing updates the existing canvas model');
  assert.equal(byId.get('erdwiden').disabled, false);
  const before = byId.get('erdgrab')._listeners.get('mousedown').length;
  ev(ctx, 'erdInspectorWire()');
  assert.equal(byId.get('erdgrab')._listeners.get('mousedown').length, before, 'wiring is idempotent');
});

test('late ERD columns cannot replace another selected table or enter a new project cache', async (t) => {
  const page = await boot(t, { deferColumns: true });
  await select(page, 'alpha_order');
  await select(page, 'beta|beta_invoice');
  assert.deepEqual(page.pending.map((p) => p.project), ['alpha', 'beta']);
  page.pending[1].release();
  await settle(page.ctx, 8);
  page.pending[0].release();
  await settle(page.ctx, 8);
  assert.match(rows(page)[0].querySelector('.erdcolcomment').textContent, /^beta /);
  ev(page.ctx, "ERD.cols.delete('alpha_order'); erdSelect('alpha_order')");
  await settle(page.ctx, 8);
  assert.equal(page.pending.length, 3);
  ev(page.ctx, "switchProject('beta')");
  await settle(page.ctx, 15);
  page.pending[2].release();
  await settle(page.ctx, 8);
  assert.equal(ev(page.ctx, "ERD.cols.has('alpha_order')"), false);
});
