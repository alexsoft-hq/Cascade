// Lossless shared evidence for flow pages; byte cuts remove whole lane rows.
import { makeResponse } from './contract.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

function dictionary() {
  const values = {}, keys = new Map();
  return { values, ref(value) {
    const key = JSON.stringify(value);
    if (!keys.has(key)) { const id = String(keys.size); keys.set(key, id); values[id] = value; }
    return keys.get(key);
  } };
}

function encodePage(answer, fields, counts, maxBytes) {
  const edges = dictionary(), links = dictionary(), reasons = dictionary();
  const evidence = (value) => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(evidence);
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      key === 'basis' && typeof item === 'string' ? ['basisRef', reasons.ref(item)] : [key, evidence(item)]));
  };
  const row = (item) => Object.fromEntries(Object.entries(item).map(([key, value]) => {
    if ((key === 'path' || key === 'walkedPath') && Array.isArray(value)) return [`${key}Refs`, value.map((edge) => edges.ref(evidence(edge)))];
    if (key === 'link' && value && typeof value === 'object') return ['linkRef', links.ref(evidence(value))];
    return [key, value];
  }));
  const out = { ...answer, empty: { ...answer.empty }, format: 'flow:compact:1' };
  for (const { field } of fields) {
    out[field] = answer[field].slice(0, counts[field]).map(row);
    if (out[field].length) delete out.empty[field];
    else if (answer[field].length) out.empty[field] = 'not-in-this-axis';
  }
  if (!answer.empty && Object.keys(out.empty).length === 0) delete out.empty;
  out.evidence = { edges: edges.values, links: links.values, reasons: reasons.values };
  out.budget = { maxBytes, scope: 'answer-json-utf8' };
  return out;
}

function prefixCounts(order, fields, count) {
  const counts = Object.fromEntries(fields.map(({ field }) => [field, 0]));
  for (const field of order.slice(0, count)) counts[field]++;
  return counts;
}

/** Keep nearest rows from every lane, never shorten an individual proof path. */
export function compactFlowResponse(response, { maxBytes, offset }) {
  const fields = response.truncated.fields.filter(({ field }) => Array.isArray(response.answer[field]));
  const order = [];
  for (let i = 0; fields.some(({ field }) => i < response.answer[field].length); i++) {
    for (const { field } of fields) if (i < response.answer[field].length) order.push(field);
  }
  const render = (n) => encodePage(response.answer, fields, prefixCounts(order, fields, n), maxBytes);
  if (bytes(render(0)) > maxBytes) return null; // caller reports an explicit budget error
  let low = 0, high = order.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(render(middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const answer = render(low);
  const truncated = response.truncated.fields.map((field) => {
    if (!Array.isArray(answer[field.field])) return field;
    const shown = answer[field.field].length;
    if (shown === field.shown) return field;
    const next = offset + shown;
    return { ...field, shown, nextOffset: next > 0 ? next : null, byteLimited: true,
      retry: { action: 'increase-maxBytes', offset: next } };
  });
  return makeResponse({ ...response, answer,
    truncated: { any: truncated.some((field) => field.nextOffset != null || field.byteLimited), fields: truncated } });
}
