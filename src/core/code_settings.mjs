// code_settings.mjs — the settings a project makes in code that the engine reads from the profile instead, said when the profile is silent about them.
//
// A `java.code-setting` rule names the calls that make such a setting
// (src/core/rules/packs/spring-mvc.json: setPathPrefixes, addPathPrefix) and the
// profile key that stands for it. When the Java facts show one of those calls
// and the key is still at its default, the routes this pack records may be
// missing what the call sets, and a reader is owed the file, the line and the
// key to fill in. When the key is declared, it is the project's word and
// nothing is said.

import { isNonDefault, readKeyPath } from './profile.mjs';
import { builtinRegistry } from './rules/registry.mjs';
import { codeSettingsIn } from './rules/kinds/java_code_setting.mjs';

/** How many call sites one diagnostic names before it counts the rest. */
const SITES_SHOWN = 3;

/** `file:line calls On.method`, the way a reader goes and looks; a receiver nobody proved is said as one. */
const siteOf = (f) => `${f.file ?? '(unknown file)'}${f.line ? `:${f.line}` : ''} calls `
  + (f.proof === 'import' ? `${f.method} on a receiver whose type is not read, in a file that imports ${f.on}` : `${f.on}.${f.method}`);

/**
 * One diagnostic per rule whose calls the Java facts show while the profile
 * leaves its key undeclared.
 *
 * @param {object[]} javaFacts  the assembled Java worker records
 * @param {object} profile  the normalized profile
 * @param {{compiled:object}[]} [rules]  the `java.code-setting` rules; the engine's own by default
 * @returns {{kind:string, severity:string, key:string, reason:string}[]}
 */
export function codeSettingDiagnostics(javaFacts, profile, rules = builtinRegistry().ofKind('java.code-setting')) {
  const byRule = new Map();
  for (const f of codeSettingsIn(javaFacts, rules)) {
    if (isNonDefault(f.setting, readKeyPath(profile, f.setting))) continue;
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  return [...byRule.values()].map(settingDiagnostic);
}

/**
 * One rule's calls, said: the ones whose receiver proves them first, since they
 * are what a reader acts on. With none proved it is a lower note, and says so.
 */
function settingDiagnostic(all) {
  const found = [...all.filter((f) => f.proof !== 'import'), ...all.filter((f) => f.proof === 'import')];
  const { rule, setting, effect } = found[0];
  const proven = found[0].proof !== 'import';
  const more = found.length > SITES_SHOWN ? ` and ${found.length - SITES_SHOWN} more` : '';
  return {
    kind: 'SETTING_IN_CODE', severity: proven ? 'warn' : 'info', key: setting,
    reason: `${found.slice(0, SITES_SHOWN).map(siteOf).join('; ')}${more}: `
      + `${proven ? '' : 'none of these receivers is proven to be the type the rule names; if one is, '}${effect}. `
      + `This engine does not read a setting made in code, so declare it as \`${setting}\` in the profile (rule ${rule})`,
  };
}
