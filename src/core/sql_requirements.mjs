// Pure pin parsing and validation shared by setup and the doctor report.
export function sqlglotPin(requirements) {
  const pins = String(requirements).split(/\r?\n/)
    .map((line) => /^\s*sqlglot==([^\s;#]+)\s*(?:#.*)?$/.exec(line))
    .filter(Boolean);
  if (pins.length !== 1) throw new Error('requirements.txt must contain exactly one sqlglot==version pin');
  return pins[0][1];
}

export function sqlglotMatches(probe, expectedVersion) {
  return Boolean(expectedVersion && probe?.ok && probe.version === expectedVersion);
}
