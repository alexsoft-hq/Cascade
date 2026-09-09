// eslint.config.js — the linter, and only the rules that catch a REAL defect.
//
// WHY A LINTER AT ALL, in a repository that had none. Not for style: this code
// is read far more often than it is written, and a reviewer's eye is better at
// style than any rule. It is here for the four mistakes a human reader reliably
// misses in a file of two thousand lines — a variable that is declared and never
// used (usually the leftover half of a rename), a name that shadows the one an
// outer scope is still using, `==` where a type coercion decides the answer, and
// a `var` whose scope is the whole function rather than the block it is written
// in. Every one of those has produced a bug in a codebase this shape.
//
// WHAT IS DELIBERATELY NOT HERE.
//   max-lines-per-function   test/code_shape.test.mjs does that job instead,
//                            with a per-file baseline that can only be sealed
//                            downward. One number for a whole repository is
//                            either so high it means nothing or so low it is
//                            switched off within a week.
//   formatting rules         nothing here reformats code. A diff that is half
//                            re-indentation is a diff nobody reviews.
//
// `npm run lint` runs it; the `lint` job in .github/workflows/ci.yml runs the
// same command, independent of every other job.

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // NOT LINTED, and each for its own reason:
    //   node_modules            not ours
    //   adapters/web/vendor     the vendored Babel parser, verbatim upstream
    //   viewer/vendor           the vendored force-graph builds, minified
    //   .oss-work / .java-build / .venv  scratch and build output, not source
    ignores: [
      'node_modules/**',
      'adapters/web/vendor/**',
      'viewer/vendor/**',
      '.oss-work/**',
      '.java-build/**',
      '.venv/**',
      // ANALYSIS INPUT, not source. These trees are what the web lane READS: an
      // AngularJS app written in the style of 2014, a file that deliberately
      // does not parse, a `.d.ts` this lane must skip. Linting them would ask
      // the fixtures to stop being the thing they exist to be.
      'test/fixtures/**',
      // The viewer page is markup and CSS now; its code lives in viewer/js and
      // is linted below. HTML is not JavaScript, so it stays out.
      'viewer/**/*.html',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // A leftover binding is the visible half of an unfinished edit. `args:
      // after-used` keeps the positional parameters a signature needs to reach
      // the ones after them; `caughtErrors: none` keeps `catch (e) { … }` where
      // the reason is deliberately not used, which this codebase does on purpose
      // wherever a failure has one honest answer and it is not the message.
      //
      // A LEADING UNDERSCORE MEANS "ON PURPOSE". This codebase already writes
      // `fromLooseText(file, _diagnostics)` to keep one signature across four
      // readers, and `const { proposed: _p, ...rest } = c` to drop a key. Both
      // say what they are; a rule that made them say it a second way would only
      // be asking for the underscore to be deleted.
      // `ignoreRestSiblings` is the same idea said by the language rather than by
      // a name: `const { walkedPath, ...rest } = row` is how JavaScript spells
      // "everything except this one", and the named half is not a leftover.
      'no-unused-vars': ['error', {
        args: 'after-used',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      // A WARNING, not an error: shadowing is usually harmless (`const g` inside
      // a helper) and occasionally the whole bug. It is worth seeing and not
      // worth failing a build over.
      'no-shadow': 'warn',
      // `smart` allows `x == null`, which is the one coercion this codebase
      // relies on deliberately — "null or undefined", said in one comparison.
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      // These two are on because the code ALREADY named them: there were two
      // `eslint-disable-next-line` comments for them in the tree before any
      // linter ran, each beside a deliberate exception with its reason. Turning
      // the rules on makes those comments mean something; leaving them off
      // would have meant deleting them.
      'no-new': 'error',
      'no-new-func': 'error',
      // See the header: the ratchet does this, per file, with a baseline.
      'max-lines-per-function': 'off',
    },
  },
  {
    // THE VIEWER PAGE'S OWN CODE. Thirteen classic scripts and the two engine
    // modules served beside them, sharing ONE global scope in the browser (see
    // the tags at the foot of viewer/index.html). Not modules: a `const` at the
    // top of 00_state.js is visible in 45_graph.js, which is the whole point of
    // the numbering.
    files: ['viewer/js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // The two vendored map renderers, loaded by <script> before these files
        // (viewer/vendor — see NOTICE). They are the only globals on this page
        // that come from somewhere else.
        ForceGraph: 'readonly',
        ForceGraph3D: 'readonly',
      },
    },
    rules: {
      // NO no-undef HERE, and it is not laziness. These files are one scope
      // split across thirteen files: `drawMap` is declared in 45_graph.js and
      // called from 30_chrome.js, and a rule that reads one file at a time
      // cannot know that. Turning it on would mean listing four hundred names in
      // this config, or a `/* global */` line at the top of every file that grew
      // stale the first time somebody renamed a function. The page's own tests
      // (test/viewer_page.test.mjs, test/viewer_golden.test.mjs) run the whole
      // page for real, which is what actually catches a name that is not there.
      'no-undef': 'off',
      // ...and for the same reason, a declaration this file does not use is not
      // dead: it is what the next file uses.
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', vars: 'local' }],
    },
  },
  {
    // The engine modules the page is served as classic scripts. They are ES
    // modules with their own tests, so they are linted as modules — the rules
    // above already cover them; this is only about the browser they also run in.
    files: ['src/viewer/*.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
];
