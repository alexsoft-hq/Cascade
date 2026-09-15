// pack_diff_fields.mjs — content, location and duplicate-safe record comparison.
//
// A pack node has a stable identity, so an id match says nothing about whether
// its recorded meaning stayed the same. Edges have a stable relation identity
// too, but can have more than one evidence record for that relation. This file
// compares those records without using source position as semantic content.

import { canonicalJson } from './canonical.mjs';

const LOCATION_FIELDS = new Set(['file', 'line', 'declaredAt']);
const textOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sameValue = (a, b) => canonicalJson(a) === canonicalJson(b);
const copyValue = (value) => JSON.parse(canonicalJson(value));
const present = (record, key) => Object.hasOwn(record, key);

export const nodeOrder = (a, b, kindRank) => kindRank(a) - kindRank(b) || textOrder(a, b);

/** A total ordering for every edge list. Equal records compare equal. */
export function edgeOrder(a, b) {
  return textOrder(a.from, b.from) || textOrder(a.to, b.to)
    || textOrder(a.type, b.type) || textOrder(canonicalJson(a.rule), canonicalJson(b.rule));
}

function fieldRow(name, base, head) {
  const basePresent = present(base, name);
  const headPresent = present(head, name);
  return {
    name, base: basePresent ? copyValue(base[name]) : null, head: headPresent ? copyValue(head[name]) : null,
    basePresent, headPresent,
  };
}

function changedField(name, base, head) {
  const basePresent = present(base, name);
  const headPresent = present(head, name);
  return basePresent !== headPresent || (basePresent && !sameValue(base[name], head[name]));
}

function recordFields(base, head, ignored) {
  const names = new Set([...Object.keys(base), ...Object.keys(head)]);
  return [...names].filter((name) => !ignored.has(name) && changedField(name, base, head)).sort().map((name) => fieldRow(name, base, head));
}

function nodeKindOrder(byKind, kindRank) {
  return Object.fromEntries(Object.keys(byKind).sort((a, b) => kindRank(`${a}:`) - kindRank(`${b}:`) || textOrder(a, b)).map((kind) => [kind, byKind[kind]]));
}

function bumpNode(byKind, id, field) {
  const kind = String(id).slice(0, String(id).indexOf(':'));
  byKind[kind] ??= { added: 0, removed: 0, changed: 0, moved: 0 };
  byKind[kind][field] += 1;
}

function nodePair(base, head) {
  const fields = recordFields(base, head, new Set(['id', 'kind']));
  const content = fields.filter((field) => !LOCATION_FIELDS.has(field.name));
  const location = fields.filter((field) => LOCATION_FIELDS.has(field.name));
  return { fields, content, location };
}

/** Added, removed, semantic changed and location-only moved stable node ids. */
export function diffNodeRecords(basePack, headPack, changedAxes, kindRank, axisOf) {
  const baseById = new Map(basePack.nodes.map((node) => [node.id, node]));
  const headById = new Map(headPack.nodes.map((node) => [node.id, node]));
  const added = [...headById.keys()].filter((id) => !baseById.has(id)).sort((a, b) => nodeOrder(a, b, kindRank));
  const removed = [...baseById.keys()].filter((id) => !headById.has(id)).sort((a, b) => nodeOrder(a, b, kindRank));
  const byKind = {};
  for (const id of added) bumpNode(byKind, id, 'added');
  for (const id of removed) bumpNode(byKind, id, 'removed');
  const changed = [];
  const moved = [];
  for (const [id, base] of baseById) {
    const head = headById.get(id);
    if (!head) continue;
    const pair = nodePair(base, head);
    if (pair.content.length) { changed.push({ id, fields: pair.fields }); bumpNode(byKind, id, 'changed'); }
    else if (pair.location.length) { moved.push({ id, fields: pair.location }); bumpNode(byKind, id, 'moved'); }
  }
  const changedRows = changed.sort((a, b) => nodeOrder(a.id, b.id, kindRank));
  const movedRows = moved.sort((a, b) => nodeOrder(a.id, b.id, kindRank));
  const axes = new Set(changedAxes);
  const removedRows = removed.map((id) => {
    const node = baseById.get(id);
    const axis = node ? axisOf(node) : null;
    return axis && axes.has(axis) ? { id, axisChanged: axis } : { id };
  });
  return { added, removedRows, changed: changedRows, moved: movedRows, byKind: nodeKindOrder(byKind, kindRank) };
}

const edgeRule = (edge) => edge.evidence?.rule ?? null;
const edgeKey = (edge) => canonicalJson([edge.from, edge.to, edge.type, edgeRule(edge)]);
const recordOrder = (a, b) => textOrder(canonicalJson(a), canonicalJson(b));

function edgeRecord(edge) {
  const evidencePresent = present(edge, 'evidence');
  return { grade: edge.grade, evidence: evidencePresent ? copyValue(edge.evidence) : null, evidencePresent };
}

function edgesByKey(pack) {
  const groups = new Map();
  for (const edge of pack.edges) {
    const key = edgeKey(edge);
    if (!groups.has(key)) groups.set(key, { from: edge.from, to: edge.to, type: edge.type, rule: edgeRule(edge), records: [] });
    groups.get(key).records.push(edgeRecord(edge));
  }
  for (const group of groups.values()) group.records.sort(recordOrder);
  return groups;
}

const gradesOf = (records) => records.map((record) => record.grade).sort().join('+');
const objectEvidence = (record) => record.evidencePresent && record.evidence && typeof record.evidence === 'object' && !Array.isArray(record.evidence);
const evidenceOf = (record) => objectEvidence(record) ? record.evidence : {};
const reportedRecords = (records) => records.map(({ grade, evidence }) => ({ grade, evidence }));

function evidenceNames(base, head) {
  const names = new Set();
  for (const record of [...base, ...head]) for (const name of Object.keys(evidenceOf(record))) if (name !== 'rule') names.add(name);
  return [...names].sort();
}

function snapshot(records, name, withGrade) {
  return records.map((record) => {
    const evidence = evidenceOf(record);
    const value = { present: present(evidence, name), value: present(evidence, name) ? copyValue(evidence[name]) : null };
    return withGrade ? { grade: record.grade, ...value } : value;
  }).sort(recordOrder);
}

function locationOrigin(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0 && Object.keys(value).every((name) => LOCATION_FIELDS.has(name));
}

function locationEvidence(name, base, head) {
  if (LOCATION_FIELDS.has(name)) return true;
  const values = [...base, ...head].map((record) => evidenceOf(record)[name]);
  return name === 'origin' && values.every(locationOrigin);
}

function locationNames(base, head) {
  return new Set(evidenceNames(base, head).filter((name) => locationEvidence(name, base, head)));
}

function projectedEvidence(record, names, take) {
  if (!objectEvidence(record)) return take === 'content' ? { evidence: record.evidence, evidencePresent: record.evidencePresent } : { evidence: {} };
  const evidence = Object.fromEntries(Object.entries(record.evidence).filter(([name]) => name !== 'rule' && (take === 'content' ? !names.has(name) : names.has(name))));
  return { evidence };
}

function projectedRecords(records, names, take) {
  return records.map((record) => projectedEvidence(record, names, take)).sort(recordOrder);
}

function aggregateField(name, base, head) {
  const basePresent = base.length > 1 || base[0]?.evidencePresent === true;
  const headPresent = head.length > 1 || head[0]?.evidencePresent === true;
  return { name, base: copyValue(base), head: copyValue(head), basePresent, headPresent };
}

function evidenceField(name, base, head, gradesSame) {
  const plainBase = snapshot(base, name, false);
  const plainHead = snapshot(head, name, false);
  const linkedBase = snapshot(base, name, true);
  const linkedHead = snapshot(head, name, true);
  const changed = !sameValue(plainBase, plainHead) || (gradesSame && !sameValue(linkedBase, linkedHead));
  if (!changed) return null;
  const single = base.length === 1 && head.length === 1;
  const baseEntry = plainBase[0] ?? { present: false, value: null };
  const headEntry = plainHead[0] ?? { present: false, value: null };
  return single
    ? { name: `evidence.${name}`, base: baseEntry.value, head: headEntry.value, basePresent: baseEntry.present, headPresent: headEntry.present }
    : { name: `evidence.${name}`, base: linkedBase, head: linkedHead, basePresent: true, headPresent: true };
}

function changedEvidence(base, head) {
  const gradesSame = gradesOf(base) === gradesOf(head);
  const names = locationNames(base, head);
  const direct = evidenceNames(base, head).map((name) => evidenceField(name, base, head, gradesSame)).filter(Boolean);
  const content = direct.filter((field) => !names.has(field.name.slice('evidence.'.length)));
  const location = direct.filter((field) => names.has(field.name.slice('evidence.'.length)));
  const contentChanged = !sameValue(projectedRecords(base, names, 'content'), projectedRecords(head, names, 'content'));
  const locationChanged = !sameValue(projectedRecords(base, names, 'location'), projectedRecords(head, names, 'location'));
  if (contentChanged && content.length === 0) content.push(aggregateField('evidence.records', base, head));
  if (locationChanged && location.length === 0) location.push(aggregateField('evidence.locationRecords', base, head));
  return { fields: [...content, ...location].sort((a, b) => textOrder(a.name, b.name)), content, location, gradesSame };
}

const edgeIdentity = (group) => ({ from: group.from, to: group.to, type: group.type, rule: group.rule });
const edgeRow = (group, grade) => ({ ...edgeIdentity(group), grade });

function bumpEdge(byType, type, field) {
  byType[type] ??= { added: 0, removed: 0, regraded: 0, changed: 0, moved: 0 };
  byType[type][field] += 1;
}

function typeOrder(byType) {
  return Object.fromEntries(Object.keys(byType).sort().map((type) => [type, byType[type]]));
}

/** Relation-identity groups, including duplicate evidence records as multisets. */
export function diffEdgeRecords(basePack, headPack) {
  const base = edgesByKey(basePack);
  const head = edgesByKey(headPack);
  const added = [];
  const removed = [];
  const regraded = [];
  const changed = [];
  const moved = [];
  const byType = {};
  for (const [key, group] of head) {
    const before = base.get(key);
    if (!before) { added.push(edgeRow(group, gradesOf(group.records))); bumpEdge(byType, group.type, 'added'); continue; }
    const evidence = changedEvidence(before.records, group.records);
    if (!evidence.gradesSame) { regraded.push({ ...edgeIdentity(group), base: gradesOf(before.records), head: gradesOf(group.records) }); bumpEdge(byType, group.type, 'regraded'); }
    const row = { ...edgeIdentity(group), base: reportedRecords(before.records), head: reportedRecords(group.records), fields: evidence.fields };
    if (evidence.content.length) { changed.push(row); bumpEdge(byType, group.type, 'changed'); }
    else if (evidence.location.length) { moved.push({ ...row, fields: evidence.location }); bumpEdge(byType, group.type, 'moved'); }
  }
  for (const [key, group] of base) if (!head.has(key)) { removed.push(edgeRow(group, gradesOf(group.records))); bumpEdge(byType, group.type, 'removed'); }
  return {
    added: added.sort(edgeOrder), removed: removed.sort(edgeOrder), regraded: regraded.sort(edgeOrder),
    changed: changed.sort(edgeOrder), moved: moved.sort(edgeOrder), byType: typeOrder(byType),
  };
}

/** Rows name every end touched by either pack and say which pack contains it. */
export function touchedRows(baseIds, headIds, baseNodeIds, headNodeIds) {
  const base = new Set(baseIds);
  const head = new Set(headIds);
  const baseNodes = new Set(baseNodeIds);
  const headNodes = new Set(headNodeIds);
  const rows = [...new Set([...base, ...head])].sort().map((id) => ({ id, base: baseNodes.has(id), head: headNodes.has(id) }));
  return {
    endpoints: rows.filter((row) => row.id.startsWith('endpoint:')),
    screens: rows.filter((row) => row.id.startsWith('screen:')),
  };
}

function cut(field, list, limit, order) {
  const shown = Math.min(limit, list.length);
  return { shown: list.slice(0, limit), trunc: { field, shown, total: list.length, order, nextOffset: shown < list.length ? shown : null } };
}

const nodeCut = (field, list, limit) => cut(field, list, limit, 'kind, id asc');
const edgeCut = (field, list, limit) => cut(field, list, limit, 'from, to, type, rule asc');

/** Shape the public, capped pack-diff report without changing either input pack. */
export function materializePackDiff(schema, basePack, headPack, conditions, nodes, edges, touched, limit, sideOf, repository) {
  const lists = [
    nodeCut('nodes.added', nodes.added, limit), nodeCut('nodes.removed', nodes.removedRows, limit),
    nodeCut('nodes.changed', nodes.changed, limit), nodeCut('nodes.moved', nodes.moved, limit),
    edgeCut('edges.added', edges.added, limit), edgeCut('edges.removed', edges.removed, limit),
    edgeCut('edges.regraded', edges.regraded, limit), edgeCut('edges.changed', edges.changed, limit), edgeCut('edges.moved', edges.moved, limit),
    nodeCut('endpointsTouched', touched.endpoints, limit), nodeCut('screensTouched', touched.screens, limit),
  ];
  const [na, nr, nc, nm, ea, er, eg, ec, em, et, st] = lists;
  const samePack = Boolean(basePack.digest) && basePack.digest === headPack.digest;
  return {
    schema, comparisonVersion: 2, base: sideOf(basePack), head: sideOf(headPack), samePack, repository,
    conditions: { verdict: conditions.verdict, differences: conditions.differences, unknown: conditions.unknown },
    nodes: { added: nodes.added.length, removed: nodes.removedRows.length, changed: nodes.changed.length, moved: nodes.moved.length, byKind: nodes.byKind, addedIds: na.shown, removedIds: nr.shown, changedList: nc.shown, movedList: nm.shown },
    edges: { added: edges.added.length, removed: edges.removed.length, regraded: edges.regraded.length, changed: edges.changed.length, moved: edges.moved.length, byType: edges.byType, addedList: ea.shown, removedList: er.shown, regradedList: eg.shown, changedList: ec.shown, movedList: em.shown },
    endpointsTouched: { total: touched.endpoints.length, ids: et.shown.map((row) => row.id), rows: et.shown },
    screensTouched: { total: touched.screens.length, ids: st.shown.map((row) => row.id), rows: st.shown },
    truncated: { any: lists.some((list) => list.trunc.nextOffset !== null), fields: lists.map((list) => list.trunc) },
  };
}
