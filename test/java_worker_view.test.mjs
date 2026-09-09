// java_worker_view.test.mjs — what adapters/java/JavaFacts.java records about
// the PAGE a handler renders (javafacts/9), read back off real compiled-and-run
// output.
//
// A `@Controller` that is not a `@RestController` answers a request by naming a
// VIEW, and a template engine turns that name into the page the browser gets.
// This test pins the four places the worker reads that name from, and — just as
// important — the two it refuses to:
//
//   * a returned NAME (a constant, a variable, a call) is not resolved. It is
//     counted in `unresolved`, so the run can say how many pages it could not
//     name instead of guessing one;
//   * a `@RestController`, or a method carrying `@ResponseBody`, answers with a
//     body and has no view at all — no record, not an empty one.
//
// The worker decides nothing beyond that. Which FILE `owners/findOwners` means
// depends on the view resolver's prefix and suffix, which are a project's
// configuration and are joined on in src/adapters/web_bridge.mjs (I-1/I-6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { JAVA_WORKER_VERSION } from '../src/core/worker_versions.mjs';
import { javaRecordSortKey, assembleJavaFacts, splitJavaFactsByFile } from '../src/core/facts_store.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));

const SOURCES = {
  'PageController.java': `package com.example;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.ResponseBody;
import org.springframework.web.servlet.ModelAndView;

@Controller
public class PageController {

    private static final String FORM = "things/form";
    private String mutableForm = "things/mutable";
    private final Other helper = new Other();

    // 1. a returned literal.
    @GetMapping("/things")
    public String list(Model model) {
        return "things/list";
    }

    // 2. every literal leaf of a returned ternary.
    @PostMapping("/things")
    public String save(boolean bad) {
        return bad ? "things/form" : "redirect:/things";
    }

    // 3. a ModelAndView built with its view name, returned by name. The
    //    "return mav" is a NAME and is not counted as a page this worker
    //    could not read: the page is on the line that built the object.
    @GetMapping("/things/{id}")
    public ModelAndView detail() {
        ModelAndView mav = new ModelAndView("things/detail");
        mav.addObject("k", "v");
        return mav;
    }

    // 4. setViewName, on a ModelAndView this method was handed.
    @GetMapping("/things/edit")
    public void edit(ModelAndView mav) {
        mav.setViewName("things/edit");
    }

    // 5. a static final String of THIS class. The initializer is on the line
    //    above, so the name is read rather than resolved.
    @GetMapping("/things/new")
    public String create() {
        return FORM;
    }

    // 6. a private method of THIS class whose every return is a literal or one
    //    of its own constants. Read one level deep.
    @GetMapping("/things/other")
    public String other() {
        return pick();
    }

    // The same, written with an explicit receiver, and with TWO literals: two
    // views, exactly as a ternary gives two.
    @GetMapping("/things/branch")
    public String branch(boolean odd) {
        return this.branchView(odd);
    }

    // A helper whose own return is a CALL is not followed: one level, and this
    // page stays unnamed rather than guessed.
    @GetMapping("/things/deep")
    public String deep() {
        return deepView();
    }

    // A field that is not "static final" is not a constant of this class.
    @GetMapping("/things/mutable")
    public String mutable() {
        return mutableForm;
    }

    // A method of ANOTHER object is not this class's to read.
    @GetMapping("/things/elsewhere")
    public String elsewhere() {
        return helper.view();
    }

    // TWO METHODS OF ONE NAME: which overload runs depends on the argument
    // types, and this worker does not resolve types. Neither is read.
    @GetMapping("/things/ambiguous")
    public String ambiguous() {
        return both(1);
    }

    // A METHOD that answers with a body has no view, whatever the class says.
    @GetMapping("/things/count")
    @ResponseBody
    public String count() {
        return "17";
    }

    private String pick() { return FORM; }

    private String branchView(boolean odd) {
        if (odd) { return "things/odd"; }
        return "things/even";
    }

    private String deepView() { return pick(); }

    private String both(int a) { return "things/a"; }

    private String both(String a) { return "things/b"; }
}
`,
  'Other.java': `package com.example;

public class Other {
    public String view() { return "things/other"; }
}
`,
  'ApiController.java': `package com.example;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ApiController {
    @GetMapping("/api/things")
    public String list() {
        return "things/list";
    }
}
`,
};

function runWorker(jdk, dir) {
  const buildDir = path.join(dir, 'classes');
  fs.mkdirSync(buildDir, { recursive: true });
  execFileSync(jdk.javac, ['-d', buildDir, path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java')],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const src = path.join(dir, 'src');
  const out = execFileSync(jdk.java, ['-cp', buildDir, 'JavaFacts', '--root', src, src], { maxBuffer: 1 << 26 })
    .toString('utf8');
  return out.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

function writeSources(dir) {
  const src = path.join(dir, 'src', 'com', 'example');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, name), body);
}

test('javafacts/9: a handler that renders a page records the view name, and says what it could not read', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — see docs/setup/java-lane.md');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-javaview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSources(dir);
  const records = runWorker(jdk, dir);

  assert.equal(records[0].kind, 'header');
  assert.equal(records[0].version, JAVA_WORKER_VERSION, 'the mirrored version must be the one the worker stamps');

  const views = records.filter((r) => r.kind === 'view');
  const by = new Map(views.map((v) => [v.method, v]));

  // A @RestController answers with a body: no view record, from any of its methods.
  assert.deepEqual(views.filter((v) => v.owner.endsWith('ApiController')), []);
  // ...and neither does a @ResponseBody method of a page controller.
  assert.equal(by.has('count'), false);

  assert.deepEqual(by.get('list').views, [{ name: 'things/list', kind: 'view', from: 'literal' }]);
  assert.equal(by.get('list').unresolved, 0);

  // Both leaves of the ternary, and the `redirect:` prefix is the KIND rather
  // than part of the name.
  assert.deepEqual(by.get('save').views, [
    { name: 'things/form', kind: 'view', from: 'literal' },
    { name: '/things', kind: 'redirect', from: 'literal' },
  ]);

  assert.deepEqual(by.get('detail').views, [{ name: 'things/detail', kind: 'view', from: 'model-and-view' }]);
  assert.equal(by.get('detail').unresolved, 0, 'the `return mav` is the object built two lines up, not a gap');

  assert.deepEqual(by.get('edit').views, [{ name: 'things/edit', kind: 'view', from: 'set-view-name' }]);

  // A `static final String` of the SAME class, read from its own initializer.
  assert.deepEqual(by.get('create').views, [{ name: 'things/form', kind: 'view', from: 'constant' }]);
  assert.equal(by.get('create').unresolved, 0);

  // A private method of the same class, one level deep, with the method named
  // on the record so a reader is told where the name came from.
  assert.deepEqual(by.get('other').views, [
    { name: 'things/form', kind: 'view', from: 'helper', helper: 'pick' },
  ]);
  assert.equal(by.get('other').unresolved, 0);

  // Two literals in the helper are two views, exactly as a ternary gives two,
  // and an explicit `this.` receiver is the same call.
  assert.deepEqual(by.get('branch').views, [
    { name: 'things/odd', kind: 'view', from: 'helper', helper: 'branchView' },
    { name: 'things/even', kind: 'view', from: 'helper', helper: 'branchView' },
  ]);

  // Four things the worker still refuses: a helper whose own return is a call,
  // a field that is not `static final`, a method of another object, and a
  // helper name two methods answer to.
  for (const m of ['deep', 'mutable', 'elsewhere', 'ambiguous']) {
    assert.deepEqual(by.get(m).views, [], m);
    assert.equal(by.get(m).unresolved, 1, m);
  }

  // Every record carries where it was read.
  for (const v of views) {
    assert.equal(v.file, 'com/example/PageController.java');
    assert.ok(Number.isInteger(v.line) && v.line > 0);
    assert.ok(Number.isInteger(v.paramCount));
  }

  // The summary counts what it emitted.
  assert.equal(views.length, 11);
});

test('javafacts/9: the sort key core reproduces is the one the worker used', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — see docs/setup/java-lane.md');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-javaviewkey-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSources(dir);
  const records = runWorker(jdk, dir);
  const stream = records.filter((r) => r.kind !== 'header');

  // A `view` record is shard content, keyed by owner/method/arity.
  const v = stream.find((r) => r.kind === 'view');
  const SEP = String.fromCharCode(1);
  assert.equal(javaRecordSortKey(v), `4view${SEP}${v.owner}${SEP}${v.method}${SEP}${v.paramCount}`);

  // ...and the whole stream reassembles from per-file shards byte for byte,
  // which is what makes an incremental run's pack equal to a cold one's.
  const { byFile } = splitJavaFactsByFile(stream);
  const reassembled = assembleJavaFacts(byFile);
  assert.deepEqual(reassembled.map((r) => JSON.stringify(r)), stream.map((r) => JSON.stringify(r)));
});
