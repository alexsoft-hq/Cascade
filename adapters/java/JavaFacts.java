/*
 * JavaFacts — Java source-facts worker for the Cascade Java lane (SPEC §3.4, §9.1-9.2).
 *
 * Parse-only, dependency-free structural extractor. Uses the JDK compiler's
 * parse-only Tree API (ToolProvider.getSystemJavaCompiler() -> JavacTask ->
 * task.parse()) and walks com.sun.source.tree.* nodes. It NEVER calls
 * task.analyze() and does NOT require the analyzed project's dependencies
 * (Spring/MyBatis) on the classpath: parsing succeeds with those absent, and we
 * resolve names ourselves from the parse tree (package, imports, field types).
 *
 * This makes the worker robust (no "cannot find symbol" cascade) and honest:
 * the call edges it emits are name-resolved candidates, not compiler-verified
 * bindings. Per SPEC §3.1/§8.3 the downstream policy grades these SOUND_SET;
 * endpoint HANDLES and mapper-interface methods are definitional/EXACT. This
 * worker emits evidence only and never computes a grade (invariant I-1/I-6).
 *
 * Output: one compact JSON object per line on stdout, deterministic (records
 * sorted by a stable key; paths relative to --root; no timestamps, no absolute
 * paths, no machine identity). Structured diagnostics + a summary go to stderr.
 *
 * Record kinds: header, parse_error, import, type, entity, repository, field,
 * endpoint, method, transactional, call, httpCall, mpEntity, mpMapper, mpService, mpWrapper,
 * invocations, routeFunction, anonymous. EVERY record but the header carries a
 * `file`, because the incremental core shards the stream by file: a record
 * without one would be silently dropped from the cache (src/core/facts_store.mjs
 * mirrors the sort keys and a test proves the mirror byte-for-byte).
 *
 * `parse_error` is on STDOUT on purpose (javafacts/3). It used to be a stderr
 * line only, which made the parse-error count a property of ONE invocation:
 * an incremental run over three files and a cold run over the whole tree would
 * report different numbers for the same tree, and the calibration gate would
 * read that as nondeterminism. As a per-file record it rides in that file's
 * shard and the two runs agree.
 *
 * CLI: java JavaFacts --root <repoDir> (<srcRoot or file> ... | --files-from <list, one per line>)
 */

import com.sun.source.tree.AnnotatedTypeTree;
import com.sun.source.tree.AnnotationTree;
import com.sun.source.tree.ArrayTypeTree;
import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.LineMap;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewArrayTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.ParameterizedTypeTree;
import com.sun.source.tree.ReturnTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TypeParameterTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.Trees;
import com.sun.source.util.TreeScanner;

import javax.lang.model.element.Modifier;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

import java.io.File;
import java.io.IOException;
import java.io.PrintStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class JavaFacts {

    static final String SCHEMA = "cascade:javafacts:1";
    // Worker version — the identity of THIS extractor's output shape. It rides in
    // the header record and is folded into every content-addressed fact-shard key
    // (SPEC §17.7): upgrading the worker invalidates the whole cache instead of
    // mixing two generations of facts in one graph. BUMP IT whenever the records
    // this file emits change in any way. Mirrored (and asserted) in
    // src/core/worker_versions.mjs.
    static final String VERSION = "javafacts/24";
    // Internal sort-key field separator. Never emitted; unlikely to occur in code.
    static final char SEP = '\u0001';

    // ---- one output record: a stable sort key + its rendered JSON line. -------
    static final class Rec implements Comparable<Rec> {
        final String key;
        final String json;
        Rec(String key, String json) { this.key = key; this.json = json; }
        public int compareTo(Rec o) { return this.key.compareTo(o.key); }
    }

    // ---- run-wide accumulator -------------------------------------------------
    static final class Sink {
        final List<Rec> records = new ArrayList<>();
        final List<Map<String, Object>> diagnostics = new ArrayList<>();
        int files, types, endpoints, calls, methods, skippedCalls, parseErrors, transactional;
        // The half of `skippedCalls` that is a receiver THIS FILE declares — a
        // local, a parameter, a catch/lambda variable or a field whose declared
        // type the walker could not use. Split out (javafacts/7) because the other
        // half is not the same failure at all: a receiver the compilation unit
        // never declares is an INHERITED member, and those are now emitted as
        // calls with `via:"identifier"` for the bridge to resolve through the
        // supertype chain. Without the split, "skipped" hid two different things
        // behind one number.
        int skippedLocalReceivers;
        int entities, repositories;
        // MyBatis-Plus evidence (javafacts/6). Counted, never interpreted: which
        // classes carry MP mapping annotations, which interfaces/classes name an
        // entity through BaseMapper/IService/ServiceImpl, and which condition
        // wrappers a method builds. What any of it MEANS is the bridge's call.
        int mpEntities, mpWrappers;
        // MyBatis statements written as an ANNOTATION on a mapper method
        // rather than in a mapper XML (javafacts/7).
        int mapperAnnotationSql;
        // IMPERATIVE HTTP calls: a WebClient/RestClient chain or a RestTemplate
        // request, where the verb is a method name and the url is an argument
        // (javafacts/8). Counted, never interpreted: whether the url names a
        // route this pack serves is decided in src/adapters/java_bridge.mjs.
        int httpCalls;
        // The PAGE a handler renders: a `@Controller` method that names a view
        // (javafacts/9). Counted, never resolved: which template file the name
        // means depends on the view resolver's prefix and suffix.
        int views;
        // The methods declared to return a RouterFunction, each recorded as a
        // tree of what it is written with (javafacts/17). Counted, never read
        // here: which of their calls is a route is the rule pack's.
        int routeFunctions;

        void add(String key, Map<String, Object> obj) {
            records.add(new Rec(key, toJson(obj)));
        }
        void warn(String code, String file, String message) {
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("level", "warn");
            d.put("code", code);
            if (file != null) d.put("file", file);
            d.put("message", message);
            diagnostics.add(d);
        }
    }

    public static void main(String[] args) {
        String root = null;
        List<String> roots = new ArrayList<>();
        for (int i = 0; i < args.length; i++) {
            if ("--root".equals(args[i]) && i + 1 < args.length) {
                root = args[++i];
            } else if ("--files-from".equals(args[i]) && i + 1 < args.length) {
                // One target per line. An incremental run can name every file of a
                // large project, more than a command line holds.
                try {
                    for (String line : Files.readAllLines(Paths.get(args[++i]), StandardCharsets.UTF_8)) {
                        if (!line.isEmpty()) roots.add(line);
                    }
                } catch (IOException e) {
                    System.err.println("cannot read the target list " + args[i] + ": " + e.getMessage());
                    System.exit(2);
                    return;
                }
            } else {
                roots.add(args[i]);
            }
        }
        if (roots.isEmpty()) {
            System.err.println("usage: java JavaFacts --root <repoDir> (<srcRoot or file> ... | --files-from <list>)");
            System.exit(2);
            return;
        }

        Path rootPath = (root != null) ? Paths.get(root).toAbsolutePath().normalize() : null;

        // Deterministic file order (also aids reproducibility of any per-file state).
        List<File> javaFiles = new ArrayList<>();
        for (String r : roots) collectJava(new File(r), javaFiles);
        javaFiles.sort((a, b) -> a.getAbsolutePath().compareTo(b.getAbsolutePath()));

        Sink sink = new Sink();
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            System.err.println("{\"level\":\"error\",\"code\":\"no_compiler\","
                + "\"message\":\"ToolProvider.getSystemJavaCompiler() returned null; run with a JDK\"}");
            System.exit(2);
            return;
        }

        DiagnosticCollector<JavaFileObject> dc = new DiagnosticCollector<>();
        StandardJavaFileManager fm = compiler.getStandardFileManager(dc, null, StandardCharsets.UTF_8);
        try {
            Iterable<? extends JavaFileObject> units = fm.getJavaFileObjectsFromFiles(javaFiles);
            // Parse-only: -proc:none disables annotation processing; we never analyze().
            JavacTask task = (JavacTask) compiler.getTask(
                    nullWriter(), fm, dc, Arrays.asList("-proc:none"), null, units);
            // Source positions from the parse tree (no analyze needed) → 1-based
            // line numbers, so the viewer can preview the exact method from disk.
            SourcePositions srcPos = Trees.instance(task).getSourcePositions();

            Iterable<? extends CompilationUnitTree> parsed;
            try {
                parsed = task.parse();
            } catch (Throwable t) {
                // A catastrophic parse failure must not abort the whole run.
                sink.warn("parse_error", null, "task.parse() failed: " + shortMsg(t));
                parsed = Collections.emptyList();
            }

            // Which source files had ERROR diagnostics -> a per-file parse_error
            // RECORD (not only a stderr line). Emitting it on stdout is what makes
            // the parse-error count a property of the FACT SET rather than of one
            // invocation: the file's shard carries it, so an incremental run over a
            // subset and a cold run over the whole tree agree, and the calibration
            // gate can measure `javaParseErrors` instead of reporting it unknown.
            //
            // ONE record per file, chosen deterministically (lowest line, then
            // column, then message) — javac's diagnostic ORDER is not part of any
            // contract, and a shard whose bytes depended on it would break I-9.
            Map<String, long[]> errorPos = new HashMap<>();   // uri -> {line, column}
            Map<String, String> errorFiles = new HashMap<>(); // uri -> message
            for (Diagnostic<? extends JavaFileObject> d : dc.getDiagnostics()) {
                if (d.getKind() != Diagnostic.Kind.ERROR || d.getSource() == null) continue;
                String uri = d.getSource().toUri().toString();
                String msg = String.valueOf(d.getMessage(null));
                long line = d.getLineNumber();
                long col = d.getColumnNumber();
                long[] cur = errorPos.get(uri);
                if (cur == null
                        || line < cur[0]
                        || (line == cur[0] && col < cur[1])
                        || (line == cur[0] && col == cur[1] && msg.compareTo(errorFiles.get(uri)) < 0)) {
                    errorPos.put(uri, new long[]{line, col});
                    errorFiles.put(uri, msg);
                }
            }

            for (CompilationUnitTree cu : parsed) {
                String rel;
                URI uri;
                try {
                    uri = cu.getSourceFile().toUri();
                    rel = relativize(rootPath, uri);
                } catch (Exception e) {
                    uri = null;
                    rel = "<unknown>";
                }
                sink.files++;
                if (uri != null && errorFiles.containsKey(uri.toString())) {
                    String msg = errorFiles.get(uri.toString());
                    long[] pos = errorPos.get(uri.toString());
                    int line = (pos != null && pos[0] > 0) ? (int) pos[0] : 0;
                    sink.parseErrors++;
                    Map<String, Object> pe = new LinkedHashMap<>();
                    pe.put("kind", "parse_error");
                    pe.put("line", line);
                    pe.put("message", msg);
                    pe.put("file", rel);
                    sink.add("0parse" + SEP + rel, pe);
                    sink.warn("parse_error", rel, msg);
                }
                try {
                    new FileWalker(sink, rel, srcPos, cu).walk(cu);
                } catch (Throwable t) {
                    // One file's scan must never crash the run.
                    sink.warn("scan_error", rel, shortMsg(t));
                }
            }
        } finally {
            try { fm.close(); } catch (IOException ignored) { }
        }

        emit(sink);
    }

    // =========================================================================
    // Per-file walk
    // =========================================================================
    static final class FileWalker {
        final Sink sink;
        final String rel;
        final SourcePositions srcPos;
        final CompilationUnitTree cu;
        final LineMap lineMap;
        String pkg = "";
        // simple name -> FQN, from non-static, non-star imports in this file.
        final Map<String, String> imports = new LinkedHashMap<>();
        // ordered list of (simple, fqn) to emit as import records per top type.
        final List<String[]> importList = new ArrayList<>();
        // on-demand (wildcard) import packages, e.g. "com.macro.mall.mapper" from
        // `import com.macro.mall.mapper.*;` — emitted as import records with
        // simple="*" so the bridge can resolve a simple name against the package.
        final List<String> wildcardList = new ArrayList<>();
        // Simple names brought in by STATIC imports (`import static x.Y.assertThat;`
        // and `import static x.Y.*;` -> the marker "*"). An unqualified call whose
        // name is statically imported is NOT a call on the enclosing type, so the
        // self-call rule below must not claim it.
        final java.util.Set<String> staticImportNames = new java.util.HashSet<>();
        // EVERY name this compilation unit declares as a variable: fields (static
        // ones too), method and constructor parameters, locals, catch parameters,
        // for-loop and lambda variables, in every type in the file.
        //
        // It answers ONE question, and it is the question that separates two very
        // different receivers spelled the same way (javafacts/7). `x.m()` where
        // `x` is declared somewhere in this file is a local/param/field the walker
        // could not type — a skip, as before. `x.m()` where NOTHING in the file
        // declares `x` cannot be a local: Java resolves that name in the
        // enclosing type's INHERITED members, and the declaration is in a
        // superclass this worker is not allowed to read (parse-only, one file at
        // a time). So the NAME is emitted as evidence with `toTypeSimple:null`
        // and the bridge — which has every type record — decides what it is.
        //
        // Compilation-unit scope, not block scope, on purpose: it can only ever
        // make the worker emit FEWER identifier receivers, never a wrong one, and
        // a shadowing local anywhere in the file keeps the call a skip.
        final java.util.Set<String> declaredNames = new java.util.HashSet<>();

        FileWalker(Sink sink, String rel, SourcePositions srcPos, CompilationUnitTree cu) {
            this.sink = sink; this.rel = rel; this.srcPos = srcPos; this.cu = cu;
            this.lineMap = cu.getLineMap();
        }

        // 1-based start line of a tree node, or 0 when unavailable.
        int lineOf(Tree t) {
            try {
                long pos = srcPos.getStartPosition(cu, t);
                if (pos < 0 || lineMap == null) return 0;
                return (int) lineMap.getLineNumber(pos);
            } catch (Throwable ignored) { return 0; }
        }

        /**
         * The 1-based declaration line of every entry of `declaredMethodsOf(ct)`,
         * in the SAME order (javafacts/7).
         *
         * A method a class only INHERITS is instantiated downstream as a member
         * of the concrete class, and a reader who opens it must land on the line
         * that really declares it — in the ancestor's file. Without this the
         * bridge knows the ancestor but not where in it, and the source preview
         * opens a file at no particular place.
         *
         * The first declaration of a "name/arity" wins, exactly as the key list
         * dedupes it, so the two lists cannot drift apart.
         */
        List<Object> declaredMethodLinesOf(ClassTree ct) {
            Map<String, Integer> firstLine = new LinkedHashMap<>();
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof MethodTree)) continue;
                MethodTree m = (MethodTree) member;
                String n = m.getName().toString();
                if ("<init>".equals(n)) continue;
                String key = n + "/" + m.getParameters().size();
                if (!firstLine.containsKey(key)) firstLine.put(key, lineOf(m));
            }
            List<Object> out = new ArrayList<>();
            for (String key : declaredMethodKeys(ct)) out.add(firstLine.get(key));
            return out;
        }

        void walk(CompilationUnitTree cu) {
            ExpressionTree pkgTree = cu.getPackageName();
            pkg = (pkgTree != null) ? pkgTree.toString() : "";
            for (ImportTree imp : cu.getImports()) {
                String qs = imp.getQualifiedIdentifier().toString();
                if (imp.isStatic()) {
                    int sdot = qs.lastIndexOf('.');
                    staticImportNames.add((sdot >= 0) ? qs.substring(sdot + 1) : qs);
                    continue;
                }
                String q = qs;
                int dot = q.lastIndexOf('.');
                String simple = (dot >= 0) ? q.substring(dot + 1) : q;
                if ("*".equals(simple)) { // on-demand import: record the package
                    String pkgOfStar = (dot >= 0) ? q.substring(0, dot) : "";
                    if (!pkgOfStar.isEmpty()) wildcardList.add(pkgOfStar);
                    continue;
                }
                imports.put(simple, q);
                importList.add(new String[]{simple, q});
            }
            // Collect every declared variable name BEFORE any type is walked: a
            // call in the first method of the file may name a local declared in
            // the last, and a one-pass answer would depend on reading order.
            cu.accept(new TreeScanner<Void, Void>() {
                @Override public Void visitVariable(VariableTree v, Void p) {
                    declaredNames.add(v.getName().toString());
                    return super.visitVariable(v, p);
                }
            }, null);
            emitInvocations(cu);
            emitConstructions(cu);
            for (Tree decl : cu.getTypeDecls()) {
                if (decl instanceof ClassTree) {
                    processType((ClassTree) decl, null);
                }
            }
        }

        /**
         * EVERY METHOD NAME THIS FILE INVOKES, with the line of its first call
         * (javafacts/16), and what each call's receiver is declared as
         * (javafacts/19). One record per file, one entry per name, in name order.
         *
         * What a call is FOR is not decided here. A rule pack names the calls
         * that mean something (src/core/rules/packs/spring-mvc.json names
         * setPathPrefixes and addPathPrefix, which set path prefixes in code),
         * and the engine reads them from this record. A name alone does not say
         * which method runs (`storage.addPathPrefix` is not Spring's), so each
         * name carries its receivers, `[receiver, first line]` per distinct one:
         * the type written where the receiver is declared (a local, a parameter,
         * a field of the enclosing class, a `new X()` or a cast), as written;
         * `this:<class>` for a call on the enclosing named class itself; and `?`
         * where this file does not state it (a chain, a lambda parameter with no
         * written type, an anonymous class's own call, a name declared twice).
         * EVIDENCE ONLY: which of those types a rule means is src/core's.
         * The whole unit is walked, so a call in a field initializer, a lambda
         * or an anonymous class counts too. The line is the line of the NAME,
         * so a call at the end of a chain points at itself.
         */
        void emitInvocations(CompilationUnitTree unit) {
            final java.util.TreeMap<String, java.util.TreeMap<String, Integer>> seen = new java.util.TreeMap<>();
            new InvocationScanner(pkg) {
                @Override void found(String name, String receiver, Tree sel) {
                    int line = nameLineOf(sel);
                    java.util.TreeMap<String, Integer> byReceiver = seen.computeIfAbsent(name, k -> new java.util.TreeMap<>());
                    Integer prev = byReceiver.get(receiver);
                    if (prev == null || (line > 0 && (prev == 0 || line < prev))) byReceiver.put(receiver, line);
                }
            }.scan(unit, null);
            if (seen.isEmpty()) return;
            List<Object> names = new ArrayList<>();
            List<Object> lines = new ArrayList<>();
            List<Object> receivers = new ArrayList<>();
            for (Map.Entry<String, java.util.TreeMap<String, Integer>> e : seen.entrySet()) {
                names.add(e.getKey());
                int first = 0;
                List<Object> list = new ArrayList<>();
                for (Map.Entry<String, Integer> r : e.getValue().entrySet()) {
                    int l = r.getValue();
                    if (first == 0 || (l > 0 && l < first)) first = l;
                    List<Object> pair = new ArrayList<>();
                    pair.add(r.getKey());
                    pair.add(l);
                    list.add(pair);
                }
                lines.add(first);
                receivers.add(list);
            }
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("kind", "invocations");
            r.put("names", names);
            r.put("lines", lines);
            r.put("receivers", receivers);
            r.put("file", rel);
            sink.add("9invocations" + SEP + rel, r);
        }

        /**
         * EVERY TYPE THIS FILE CONSTRUCTS with `new`, as written, with the line
         * of its first construction (javafacts/24). One record per file, one
         * entry per name, in name order. Which of them is an EntityManagerFactory
         * the project builds by hand is a rule pack's question
         * (src/core/rules/packs/jpa.json); this only says what `new` names.
         */
        void emitConstructions(CompilationUnitTree unit) {
            final java.util.TreeMap<String, Integer> seen = new java.util.TreeMap<>();
            unit.accept(new TreeScanner<Void, Void>() {
                @Override public Void visitNewClass(NewClassTree nc, Void p) {
                    String w = writtenName(nc.getIdentifier());
                    if (w != null) {
                        int line = lineOf(nc);
                        Integer prev = seen.get(w);
                        if (prev == null || (line > 0 && (prev == 0 || line < prev))) seen.put(w, line);
                    }
                    return super.visitNewClass(nc, p);
                }
            }, null);
            if (seen.isEmpty()) return;
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("kind", "constructions");
            r.put("names", new ArrayList<Object>(seen.keySet()));
            r.put("lines", new ArrayList<Object>(seen.values()));
            r.put("package", pkg);
            r.put("file", rel);
            sink.add("9constructions" + SEP + rel, r);
        }

        /** The 1-based line a method NAME is written on: where its select ends, else where it starts. */
        int nameLineOf(Tree sel) {
            try {
                long end = srcPos.getEndPosition(cu, sel);
                if (end > 0 && lineMap != null) return (int) lineMap.getLineNumber(end - 1);
            } catch (Throwable ignored) { /* fall back to the start */ }
            return lineOf(sel);
        }

        /**
         * One `anonymous` record per anonymous class this type's own code writes
         * (javafacts/20): the type it extends or implements, as written, and the
         * methods it declares. `Hd hd = new Hd(){ public R h(...) {...} };` is an
         * object of type Hd whose h is this one, so a call or a handler through
         * a Hd may run it. EVIDENCE ONLY; the id is this type's name, `$anonymous`
         * and the order the classes are written in, which is not javac's
         * binary name. A nested named type is its own owner and is left out.
         */
        void emitAnonymous(final String fqn, ClassTree ct) {
            final int[] n = { 0 };
            final Map<String, Integer> locals = new HashMap<>();
            for (Tree member : ct.getMembers()) {
                if (member instanceof ClassTree) continue;
                member.accept(new TreeScanner<Void, Void>() {
                    // A class a method body declares (javafacts/22) is a class of its
                    // own, written in this file; an anonymous class body is not one.
                    @Override public Void visitClass(ClassTree local, Void p) {
                        if (!local.getSimpleName().toString().isEmpty()) emitLocal(fqn, local, locals);
                        return super.visitClass(local, p);
                    }
                    @Override public Void visitNewClass(NewClassTree nc, Void p) {
                        ClassTree body = nc.getClassBody();
                        if (body != null) {
                            n[0]++;
                            String id = fqn + "$anonymous" + n[0];
                            Map<String, Object> rec = new LinkedHashMap<>();
                            rec.put("kind", "anonymous");
                            rec.put("id", id);
                            rec.put("owner", fqn);
                            rec.put("supertype", typeSimpleName(nc.getIdentifier()));
                            rec.put("supertypeWritten", writtenName(nc.getIdentifier()));
                            rec.put("declaredMethods", declaredMethodsOf(body));
                            rec.put("declaredMethodLines", declaredMethodLinesOf(body));
                            rec.put("line", lineOf(nc));
                            rec.put("file", rel);
                            sink.add("2anon" + SEP + id, rec);
                        }
                        return super.visitNewClass(nc, p);
                    }
                }, null);
            }
        }

        /**
         * One route a mapping annotation declares. A path, a method list or a
         * request condition this file does not state rides on the record as
         * written (javafacts/22), and is absent where the file states them all,
         * so such a record is byte for byte what it always was.
         */
        void emitEndpoint(String handler, String fqn, Mapping mp, PathRead path, String pathKey, MethodTree m) {
            Map<String, Object> ep = new LinkedHashMap<>();
            ep.put("kind", "endpoint");
            ep.put("httpMethod", mp.httpMethod);
            ep.put("path", path.known() ? path.text : null);
            ep.put("handler", handler);
            ep.put("handlerType", fqn);
            ep.put("line", lineOf(m));
            ep.put("file", rel);
            if (!path.known()) {
                ep.put("pathParts", path.parts);
                ep.put("pathWritten", path.written);
            }
            if (mp.methodUnread != null) ep.put("methodUnread", mp.methodUnread);
            if (mp.conditions != null && !mp.conditions.isEmpty()) ep.put("conditions", mp.conditions);
            sink.endpoints++;
            sink.add("4endpoint" + SEP + handler + SEP + mp.httpMethod + SEP + pathKey, ep);
        }

        /** Packages whose annotations are never a mapping this tree composes: the JDK's and the frameworks' own. */
        final String[] FOREIGN_ANNOTATION_PACKAGES = { "java.", "javax.", "jakarta.", "org.springframework.", "io.swagger.", "lombok." };
        /** The annotations java.lang declares, which a file uses with no import. */
        final java.util.Set<String> LANG_ANNOTATIONS = new java.util.HashSet<>(java.util.Arrays.asList(
                "Override", "Deprecated", "SuppressWarnings", "SafeVarargs", "FunctionalInterface"));

        /**
         * Whether an annotation this worker does not know may be a mapping
         * annotation the tree composes (javafacts/22): anything but the JDK's and
         * the frameworks' own, which this file names by its imports.
         */
        boolean mayComposeMapping(String simple, String written) {
            if (LANG_ANNOTATIONS.contains(written)) return false;
            String q = written.contains(".") ? written : imports.get(simple);
            if (q == null) return true;
            for (String p : FOREIGN_ANNOTATION_PACKAGES) if (q.startsWith(p)) return false;
            return true;
        }

        /**
         * A METHOD OF A CONTROLLER WITH NO MAPPING THIS WORKER KNOWS, and an
         * annotation it does not know (javafacts/22): `@AnonymousPostMapping("/login")`
         * is a route when the tree declares that annotation with a meta
         * @RequestMapping, which is another file's fact. What this file states
         * is recorded (the annotation, its value and path, the class's paths and
         * methods) and the bridge reads it against the annotation's own record.
         */
        void emitMappingCandidates(String fqn, String mname, MethodTree m, List<PathRead> bases, Verbs classVerbs,
                                   Map<String, String> own, String ownSimple) {
            for (AnnotationTree a : m.getModifiers().getAnnotations()) {
                String simple = typeSimpleName(a.getAnnotationType());
                String written = writtenName(a.getAnnotationType());
                if (simple == null || written == null || !mayComposeMapping(simple, written)) continue;
                Map<String, Object> rec = new LinkedHashMap<>();
                rec.put("kind", "mappingCandidate");
                rec.put("handler", fqn + "#" + mname);
                rec.put("owner", fqn);
                rec.put("annotation", written);
                rec.put("value", readsJson(annAttr(a, "value"), own, ownSimple));
                rec.put("path", readsJson(namedAttr(a, "path"), own, ownSimple));
                List<Object> b = new ArrayList<>();
                for (PathRead p : bases) b.add(readJson(p));
                rec.put("bases", b);
                rec.put("classMethods", classVerbs == null ? null : verbsJson(classVerbs));
                rec.put("line", lineOf(m));
                rec.put("file", rel);
                sink.add("4mapcand" + SEP + fqn + "#" + mname + SEP + written, rec);
            }
        }

        /**
         * AN ANNOTATION TYPE THAT IS A MAPPING (javafacts/22): an @interface
         * meta-annotated with @RequestMapping or one of its shortcuts. Its methods
         * and path are the meta annotation's; an attribute it declares with
         * @AliasFor to that annotation's `value` or `path` is where a use of it
         * writes the path. EVIDENCE ONLY: which method uses it is another file's.
         */
        void emitComposedMapping(String fqn, ClassTree ct, List<AnnotationTree> anns) {
            for (AnnotationTree a : anns) {
                String meta = typeSimpleName(a.getAnnotationType());
                Verbs v = verbsOfMapping(meta, a);
                if (v == null) continue;
                Map<String, Object> rec = new LinkedHashMap<>();
                rec.put("kind", "composedMapping");
                rec.put("fqn", fqn);
                rec.put("meta", meta);
                rec.put("methods", verbsJson(v));
                rec.put("paths", readsJson(annAttr(a, "value") != null ? annAttr(a, "value") : annAttr(a, "path"), null, null));
                rec.put("aliases", aliasesOf(ct, meta));
                rec.put("line", lineOf(ct));
                rec.put("file", rel);
                sink.add("2composed" + SEP + fqn, rec);
                return;
            }
        }

        /**
         * One `local` record per class a method body of this type declares
         * (javafacts/22): the types it extends and implements, as written, and the
         * methods it declares. `Svc make(){ class Local implements Svc {...} }` is
         * an implementor of Svc like any other, so a handler through a Svc may run
         * its methods. The id is this type's name, `$`, the order among the local
         * classes of that name, and the name, as javac numbers them.
         */
        void emitLocal(String fqn, ClassTree local, Map<String, Integer> locals) {
            String nm = local.getSimpleName().toString();
            int k = locals.merge(nm, 1, Integer::sum);
            String id = fqn + "$" + k + nm;
            List<String> sup = new ArrayList<>();
            List<String> supWritten = new ArrayList<>();
            if (local.getExtendsClause() != null) {
                sup.add(typeSimpleName(local.getExtendsClause()));
                supWritten.add(writtenName(local.getExtendsClause()));
            }
            for (Tree t : local.getImplementsClause()) {
                sup.add(typeSimpleName(t));
                supWritten.add(writtenName(t));
            }
            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("kind", "local");
            rec.put("id", id);
            rec.put("owner", fqn);
            rec.put("name", nm);
            rec.put("supertypes", sup);
            rec.put("supertypesWritten", supWritten);
            rec.put("declaredMethods", declaredMethodsOf(local));
            rec.put("declaredMethodLines", declaredMethodLinesOf(local));
            rec.put("line", lineOf(local));
            rec.put("file", rel);
            sink.add("2local" + SEP + id, rec);
        }

        void processType(ClassTree ct, String enclosingFqn) {
            String name = ct.getSimpleName().toString();
            if (name.isEmpty()) return; // anonymous class: no stable FQN
            String fqn;
            if (enclosingFqn != null) {
                fqn = enclosingFqn + "." + name;
            } else {
                fqn = pkg.isEmpty() ? name : pkg + "." + name;
            }

            String typeKind = kindOf(ct);
            List<String> annotations = annotationNames(ct.getModifiers().getAnnotations());
            List<String> impls = new ArrayList<>();
            List<Object> implArgs = new ArrayList<>();
            List<String> implWritten = new ArrayList<>();
            for (Tree t : ct.getImplementsClause()) {
                String s = typeSimpleName(t);
                if (s == null) continue;
                impls.add(s);
                implArgs.add(typeArgSimples(t));
                implWritten.add(writtenName(t));
            }
            String ext = (ct.getExtendsClause() != null) ? typeSimpleName(ct.getExtendsClause()) : null;
            String extWritten = (ct.getExtendsClause() != null) ? writtenName(ct.getExtendsClause()) : null;
            List<String> extArgs = (ct.getExtendsClause() != null)
                    ? typeArgSimples(ct.getExtendsClause()) : new ArrayList<String>();

            // The type's own DECLARED type parameters, and the first bound of each
            // (`<T, S extends IService<T>>` -> ["T","S"] + [null,"IService"]). The
            // bridge needs them to answer "this field's declared type is a type
            // PARAMETER — what does a subclass bind it to?" (rule type-param-binding).
            List<String> typeParams = new ArrayList<>();
            List<String> typeParamBounds = new ArrayList<>();
            for (TypeParameterTree tp : ct.getTypeParameters()) {
                typeParams.add(tp.getName().toString());
                String bound = null;
                for (Tree b : tp.getBounds()) { bound = typeSimpleName(b); if (bound != null) break; }
                typeParamBounds.add(bound);
            }

            Map<String, Object> typeRec = new LinkedHashMap<>();
            typeRec.put("kind", "type");
            typeRec.put("fqn", fqn);
            typeRec.put("typeKind", typeKind);
            typeRec.put("abstract", ct.getModifiers().getFlags().contains(Modifier.ABSTRACT));
            typeRec.put("package", pkg);
            typeRec.put("annotations", annotations);
            typeRec.put("implements", impls);
            typeRec.put("implementsArgs", implArgs);
            // Each supertype as the source writes it: `a.b.C` in full, else `C`. Only the
            // name written in full says which type it is when the file's own package has
            // a type of the same simple name.
            typeRec.put("implementsWritten", implWritten);
            typeRec.put("extends", ext);
            typeRec.put("extendsArgs", extArgs);
            typeRec.put("extendsWritten", extWritten);
            typeRec.put("typeParams", typeParams);
            typeRec.put("typeParamBounds", typeParamBounds);
            // The HTTP-CLIENT annotation this type carries, verbatim: @FeignClient
            // (Spring Cloud OpenFeign) or a class-level @HttpExchange (Spring 6's
            // declarative client). EVIDENCE ONLY — this worker never decides that a
            // mapping annotation is a client call rather than a route (I-1/I-6);
            // src/adapters/java_bridge.mjs reads this and decides.
            typeRec.put("client", clientAnnotationOf(annotationsOf(ct.getModifiers().getAnnotations())));
            // Every method this type DECLARES, as "name/arity". A `super.m()` has to
            // be resolved to the first ancestor that declares `m`, and a route
            // contract to the implementer that declares the same method; both need
            // to know what a type declares WITHOUT a method record per method (which
            // would put every private helper in the pack as a node).
            typeRec.put("declaredMethods", declaredMethodsOf(ct));
            // …and where each of them is declared, aligned index-for-index.
            typeRec.put("declaredMethodLines", declaredMethodLinesOf(ct));
            // An interface's methods that have a body, as "name/arity"
            // (javafacts/20): a class that implements the interface and declares
            // no method of that name runs this one. Absent on a class, and on an
            // interface with none.
            List<String> defaults = defaultMethodsOf(ct);
            if (!defaults.isEmpty()) typeRec.put("defaultMethods", defaults);
            // The methods this type declares that carry `@ModelAttribute`
            // (javafacts/10). Spring runs them before each handler of the class, so
            // nothing in the source calls them and no call record can name them.
            // EVIDENCE ONLY: which of these types is a controller, and which of its
            // methods are handlers, is decided in src/adapters/java/calls.mjs.
            typeRec.put("modelAttributeMethods", modelAttributeMethodsOf(ct));
            // THE NAME SPRING KNOWS THIS CLASS BY (javafacts/11), when the
            // stereotype annotation gives it one: `@Service("egovCmmUseService")`.
            // EVIDENCE ONLY — whether that name settles a dispatch is decided in
            // src/adapters/java/calls.mjs, which can see whether any OTHER class
            // in the tree claims the same name.
            typeRec.put("beanName", beanNameOf(annotationsOf(ct.getModifiers().getAnnotations())));
            // The `static final String` constants this type declares with a value
            // its own file states (javafacts/22): a mapping path in another file may
            // name one, and the bridge reads it here. Absent when it declares none.
            Map<String, String> ownConstants = stringConstantsOf(ct);
            if (!ownConstants.isEmpty()) typeRec.put("constants", ownConstants);
            // An interface's abstract methods (javafacts/22): with exactly one, a
            // lambda or a method reference anywhere may be an object of it.
            if (ct.getKind() == Tree.Kind.INTERFACE) typeRec.put("abstractMethods", abstractMethodsOf(ct));
            // An annotation type the tree declares (javafacts/23), with its own
            // annotations as written: whether it can change a JPA mapping rests on
            // which package each of them is from, which the bridge reads.
            if (ct.getKind() == Tree.Kind.ANNOTATION_TYPE) {
                typeRec.put("annotationType", true);
                typeRec.put("annotationsWritten", annotationsWritten(ct.getModifiers().getAnnotations()));
            }
            typeRec.put("file", rel);
            sink.types++;
            sink.add("2type" + SEP + fqn, typeRec);
            emitAnonymous(fqn, ct);
            if (ct.getKind() == Tree.Kind.ANNOTATION_TYPE) emitComposedMapping(fqn, ct, annotationsOf(ct.getModifiers().getAnnotations()));

            // Imports belong to the file; attribute them to each top-level type
            // so the bridge can resolve simple->FQN by the call's owning type.
            if (enclosingFqn == null) {
                for (String[] si : importList) {
                    Map<String, Object> ir = new LinkedHashMap<>();
                    ir.put("kind", "import");
                    ir.put("owner", fqn);
                    ir.put("simple", si[0]);
                    ir.put("fqn", si[1]);
                    ir.put("file", rel);
                    sink.add("1import" + SEP + fqn + SEP + si[0] + SEP + si[1], ir);
                }
                for (String wp : wildcardList) {
                    Map<String, Object> ir = new LinkedHashMap<>();
                    ir.put("kind", "import");
                    ir.put("owner", fqn);
                    ir.put("simple", "*");
                    ir.put("fqn", wp); // the on-demand package, no ".*"
                    ir.put("file", rel);
                    sink.add("1import" + SEP + fqn + SEP + "*" + SEP + wp, ir);
                }
            }

            boolean isInterface = "interface".equals(typeKind);

            // --- JPA / Spring Data evidence (SPEC §15 M10) ---------------------
            // Still EVIDENCE ONLY: what the annotations say, resolved no further
            // than this file. Which physical table/column an entity maps to, and
            // what a derived query name means, is decided later by the bridge
            // (src/adapters/jpa_bridge.mjs) against the whole fact set + profile.
            List<AnnotationTree> typeAnns = annotationsOf(ct.getModifiers().getAnnotations());
            emitEntity(ct, fqn, typeAnns, annotations, ext);
            if (isInterface) emitRepository(ct, fqn, typeAnns);

            // --- MyBatis-Plus evidence (javafacts/6) ---------------------------
            // Same discipline: what the annotations SAY, resolved no further than
            // this file. Which types are MP mappers and services is no longer
            // decided here (javafacts/13): the rule pack src/core/rules/packs/
            // mybatis-plus.json reads it from the `type` record's supertypes.
            emitMpEntity(ct, fqn, typeAnns, annotations, ext);
            // The property keys a class that declares a @Bean method puts
            // (javafacts/24): where a factory and the properties it is given are made.
            if (declaresBeanMethod(ct)) emitPropertyKeys(fqn, ct);

            // --- pass 1: instance fields (class/interface-typed) ---------------
            Map<String, String> fields = new LinkedHashMap<>();
            // The type of every field AS WRITTEN (`WebClient.Builder`, not
            // `Builder`), static ones included. A second map on purpose: the
            // call scan wants the SIMPLE name of an instance field, while the
            // HTTP scan has to tell `WebClient.Builder` from any other nested
            // `Builder`, and an imperative client is as often a
            // `private static final RestTemplate` as an injected field.
            Map<String, String> fieldTypeWritten = new LinkedHashMap<>();
            for (Tree member : ct.getMembers()) {
                if (member instanceof VariableTree) {
                    VariableTree v = (VariableTree) member;
                    String written = typeWrittenName(v.getType());
                    if (written != null && !fieldTypeWritten.containsKey(v.getName().toString())) {
                        fieldTypeWritten.put(v.getName().toString(), written);
                    }
                    if (v.getModifiers().getFlags().contains(Modifier.STATIC)) continue;
                    String typeSimple = typeSimpleName(v.getType());
                    if (typeSimple == null) continue; // primitive/var/unknown: skip
                    String fname = v.getName().toString();
                    fields.put(fname, typeSimple);
                    Map<String, Object> fr = new LinkedHashMap<>();
                    fr.put("kind", "field");
                    fr.put("owner", fqn);
                    fr.put("name", fname);
                    fr.put("typeSimple", typeSimple);
                    // WHICH BEAN THIS FIELD ASKS FOR BY NAME (javafacts/11).
                    // `@Resource(name = "x")` and `@Qualifier("x")` name one bean
                    // where the declared type names a whole interface.
                    fr.put("beanName", injectedBeanNameOf(annotationsOf(v.getModifiers().getAnnotations())));
                    fr.put("file", rel);
                    sink.add("3field" + SEP + fqn + SEP + fname, fr);
                }
            }
            // MyBatis-Plus's `ServiceImpl<M, T>` declares `protected M baseMapper`,
            // and 138 call sites in jeecg-boot are spelled `baseMapper.selectList(…)`.
            // Until javafacts/6 every one of them was an unresolved receiver, because
            // the field is declared in the SUPERCLASS. The `extends ServiceImpl<M, T>`
            // clause is IN THIS FILE and it names M, so the field's declared type is
            // read from it — no cross-file lookup, and no invented field: a class that
            // does not extend ServiceImpl gains nothing. No `field` RECORD is emitted:
            // this type does not declare the field, and claiming it does would put a
            // fact in the stream that no line of this file states.
            if (ext != null && !extArgs.isEmpty()) {
                for (String implBase : MP_SERVICE_IMPL_BASES) {
                    if (implBase.equals(ext) && !fields.containsKey("baseMapper")) {
                        fields.put("baseMapper", extArgs.get(0));
                    }
                }
            }

            // A declarative HTTP client puts its own prefix on the annotation that
            // makes it a client (`@FeignClient(path="/sys")`, `@HttpExchange("/sys")`),
            // and Spring joins it in FRONT of any class-level @RequestMapping. Path
            // assembly lives in ONE place — here — so the bridge never has to
            // re-join two halves of a route.
            // …once for each path a class-level array names (javafacts/20), read
            // against the class's own constants (javafacts/22): a path written as
            // a constant of another type keeps its parts for the bridge to read.
            List<AnnotationTree> ctAnns = annotationsOf(ct.getModifiers().getAnnotations());
            List<PathRead> basePaths = new ArrayList<>();
            for (PathRead classPath : classLevelBasePaths(ctAnns, ownConstants, name)) {
                basePaths.add(withClientPath(clientPathOf(ctAnns), classPath));
            }
            Verbs classVerbs = classLevelVerbs(ctAnns);
            // @Transactional at class level applies to every method (a transaction
            // boundary); method-level overrides/adds. Recorded so the graph can
            // show a transaction's read/write footprint.
            boolean classTx = annotationNames(ct.getModifiers().getAnnotations()).contains("Transactional");

            // --- what a returned NAME can mean, inside this class ---------------
            //
            // Two shapes account for nearly every view name a real Spring
            // controller does not write at the return statement, and both are
            // readable HERE, in this file, with no data-flow analysis:
            //
            //   private static final String FORM = "owners/createOrUpdateOwnerForm";
            //   …
            //   return FORM;                       -> the field's own initializer
            //   return addPaginationModel(page, …); -> a private helper of this class
            //
            // Collected BEFORE the method loop, because a helper is as often
            // declared after the handler that calls it as before it. Anything a
            // name could ALSO mean — a field two classes up, a method somebody
            // overrides, a constant from another file — is not here and is not
            // guessed: `scanViews` counts it as a page it could not name.
            Map<String, String> viewConstants = new LinkedHashMap<>();
            Map<String, MethodTree> viewHelpers = new LinkedHashMap<>();
            java.util.Set<String> ambiguousHelpers = new java.util.LinkedHashSet<>();
            for (Tree member : ct.getMembers()) {
                if (member instanceof VariableTree) {
                    VariableTree v = (VariableTree) member;
                    java.util.Set<Modifier> flags = v.getModifiers().getFlags();
                    if (!flags.contains(Modifier.STATIC) || !flags.contains(Modifier.FINAL)) continue;
                    if (!"String".equals(typeSimpleName(v.getType()))) continue;
                    String value = firstString(unwrap(v.getInitializer()));
                    if (value != null) viewConstants.put(v.getName().toString(), value);
                } else if (member instanceof MethodTree) {
                    MethodTree m = (MethodTree) member;
                    java.util.Set<Modifier> flags = m.getModifiers().getFlags();
                    // Private or package-private: a method nobody outside this file
                    // can override, so what this file reads is what runs.
                    if (flags.contains(Modifier.PUBLIC) || flags.contains(Modifier.PROTECTED)) continue;
                    if (m.getBody() == null) continue;
                    String helperName = m.getName().toString();
                    // TWO METHODS OF ONE NAME is a real ambiguity: which overload a
                    // call reaches depends on the argument types, and this worker
                    // does not resolve types. Neither is read.
                    if (viewHelpers.containsKey(helperName)) { ambiguousHelpers.add(helperName); continue; }
                    viewHelpers.put(helperName, m);
                }
            }
            for (String helperName : ambiguousHelpers) viewHelpers.remove(helperName);

            // A TYPE THAT RENDERS PAGES, not one that answers with data
            // (javafacts/9): `@Controller` without `@RestController` and without a
            // class-level `@ResponseBody`. `@RestController` IS `@Controller` plus
            // `@ResponseBody`, so a class carrying both returns bodies and never a
            // view name.
            List<String> ctAnnNames = annotationNames(ct.getModifiers().getAnnotations());
            boolean rendersViews = ctAnnNames.contains("Controller")
                    && !ctAnnNames.contains("RestController")
                    && !ctAnnNames.contains("ResponseBody");
            // A CLASS THAT SERVES ROUTES, whose methods may carry a mapping annotation
            // the tree composes (javafacts/22): only there is an annotation this
            // worker does not know recorded for the bridge to read.
            boolean routeHolder = !isInterface && (ctAnnNames.contains("Controller") || ctAnnNames.contains("RestController"));

            // --- pass 2: methods (endpoints, method records, calls) ------------
            for (Tree member : ct.getMembers()) {
                if (member instanceof ClassTree) {
                    processType((ClassTree) member, fqn);
                } else if (member instanceof MethodTree) {
                    MethodTree m = (MethodTree) member;
                    String mname = m.getName().toString();
                    int paramCount = m.getParameters().size();
                    boolean isHandler = false;

                    // Transaction boundary: method-level @Transactional (mall marks
                    // it on the service INTERFACE declaration — no body — and it
                    // applies to the impl at runtime, reachable via dispatch), or a
                    // class-level @Transactional on a concrete method.
                    boolean methodTx = annotationNames(m.getModifiers().getAnnotations()).contains("Transactional");
                    if (methodTx || (classTx && m.getBody() != null)) {
                        String txm = fqn + "#" + mname;
                        Map<String, Object> tr = new LinkedHashMap<>();
                        tr.put("kind", "transactional");
                        tr.put("method", txm);
                        tr.put("scope", methodTx ? "method" : "class");
                        tr.put("line", lineOf(m));
                        tr.put("file", rel);
                        sink.transactional++;
                        sink.add("6tx" + SEP + txm, tr);
                    }

                    List<Mapping> mappings = methodMappings(m, ownConstants, name, classVerbs);
                    if (mappings != null) {
                        isHandler = true;
                        String handler = fqn + "#" + mname;
                        // A route for each class path, method and path the
                        // annotations name; two spellings of one route are one.
                        java.util.Set<String> seenRoutes = new java.util.HashSet<>();
                        for (PathRead basePath : basePaths) {
                            for (Mapping mp : mappings) {
                                PathRead path = joinReads(basePath, mp.path);
                                String pathKey = path.known() ? path.text : "?" + path.written;
                                if (!seenRoutes.add(mp.httpMethod + " " + pathKey + " " + path.parts)) continue;
                                emitEndpoint(handler, fqn, mp, path, pathKey, m);
                            }
                        }
                    } else if (routeHolder) {
                        emitMappingCandidates(fqn, mname, m, basePaths, classVerbs, ownConstants, name);
                    }

                    // method records: interface methods (mapper bindings) + handlers.
                    if (isInterface || isHandler) {
                        String mfqn = fqn + "#" + mname;
                        Map<String, Object> mr = new LinkedHashMap<>();
                        mr.put("kind", "method");
                        mr.put("fqn", mfqn);
                        mr.put("owner", fqn);
                        mr.put("name", mname);
                        mr.put("paramCount", paramCount);
                        mr.put("line", lineOf(m));
                        mr.put("file", rel);
                        sink.methods++;
                        sink.add("5method" + SEP + mfqn + SEP + paramCount, mr);
                    }

                    // MyBatis's four statement annotations. Evidence only: the
                    // TEXT as the source wrote it, the verb the annotation names,
                    // and where it is. Whether that text is SQL this engine can
                    // read, what it touches, and whether an XML statement for the
                    // same method overrides it, are all decided downstream.
                    emitMapperAnnotationSql(fqn, mname, m);
                    emitRouteFunction(fqn, mname, m, viewConstants);
                    if (annotationNames(m.getModifiers().getAnnotations()).contains("Bean")) emitBeanMethod(fqn, mname, m);

                    if (m.getBody() != null) {
                        scanCalls(fqn, mname, fields, ext, viewConstants, m);
                        scanWrappers(fqn, mname, fields, m);
                        scanHttpCalls(fqn, mname, fieldTypeWritten, m);
                        // A handler of a page-rendering controller, unless the
                        // METHOD itself says it answers with a body.
                        if (rendersViews && isHandler
                                && !annotationNames(m.getModifiers().getAnnotations()).contains("ResponseBody")) {
                            scanViews(fqn, mname, paramCount, m, viewConstants, viewHelpers);
                        }
                    }
                }
            }
        }

        // ---- JPA: `entity` records ----------------------------------------
        // A class annotated @Entity, @MappedSuperclass or @Embeddable. Attributes
        // come from the instance FIELDS (JPA's field access, what petclinic uses)
        // plus any GETTER that itself carries a JPA annotation (property access).
        // Every non-static field is listed: in JPA a field without @Column is
        // still persistent, and @Transient is RECORDED rather than dropped so the
        // bridge — not this worker — decides what becomes a column.
        void emitEntity(ClassTree ct, String fqn, List<AnnotationTree> typeAnns, List<String> annNames, String ext) {
            boolean entity = annNames.contains("Entity");
            boolean mapped = annNames.contains("MappedSuperclass");
            boolean embeddable = annNames.contains("Embeddable");
            if (!entity && !mapped && !embeddable) return;

            AnnotationTree table = annNamed(typeAnns, "Table");
            String tableName = (table != null) ? firstString(annAttr(table, "name")) : null;

            List<Object> attrs = new ArrayList<>();
            List<String> seen = new ArrayList<>();
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof VariableTree)) continue;
                VariableTree v = (VariableTree) member;
                if (v.getModifiers().getFlags().contains(Modifier.STATIC)) continue;
                String name = v.getName().toString();
                seen.add(name);
                attrs.add(attributeOf(name, v.getType(), annotationsOf(v.getModifiers().getAnnotations()), lineOf(v)));
            }
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof MethodTree)) continue;
                MethodTree m = (MethodTree) member;
                if (!m.getParameters().isEmpty()) continue;
                String prop = propertyNameOf(m.getName().toString());
                if (prop == null || seen.contains(prop)) continue;
                List<AnnotationTree> ma = annotationsOf(m.getModifiers().getAnnotations());
                if (!hasJpaAnnotation(ma)) continue; // an unannotated getter is not new evidence
                seen.add(prop);
                attrs.add(attributeOf(prop, m.getReturnType(), ma, lineOf(m)));
            }

            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("kind", "entity");
            rec.put("fqn", fqn);
            rec.put("tableName", tableName);
            rec.put("entity", entity);
            rec.put("mappedSuperclass", mapped);
            rec.put("embeddable", embeddable);
            rec.put("superclass", ext);
            // WHERE A HIERARCHY'S ROWS LIVE, as written (javafacts/21): the
            // strategy `@Inheritance` names (null when it names none, or is not
            // there: the JPA default, SINGLE_TABLE, is the bridge's to apply),
            // the name `@Entity(name = …)` gives the entity (the default table
            // is derived from it), and the key column `@PrimaryKeyJoinColumn`
            // names on a JOINED subclass's table.
            AnnotationTree inheritance = annNamed(typeAnns, "Inheritance");
            List<String> strategy = (inheritance != null) ? memberNames(annAttr(inheritance, "strategy")) : new ArrayList<String>();
            rec.put("inheritance", strategy.isEmpty() ? null : strategy.get(0));
            AnnotationTree entityAnn = annNamed(typeAnns, "Entity");
            rec.put("entityName", (entityAnn != null) ? firstString(annAttr(entityAnn, "name")) : null);
            AnnotationTree pkJoin = annNamed(typeAnns, "PrimaryKeyJoinColumn");
            rec.put("primaryKeyJoinColumn", (pkJoin != null) ? firstString(annAttr(pkJoin, "name")) : null);
            rec.put("attributes", attrs);
            // The named fetch plans this entity DECLARES (javafacts/10):
            // `@NamedEntityGraph(name = "Owner.pets", attributeNodes = …)`, which a
            // repository method then names with `@EntityGraph(value = "Owner.pets")`.
            // Recorded here because the name is declared on the ENTITY and used in
            // another file; the bridge is the only place that holds both.
            // `subgraphs` are not read — a nested plan is a fetch this lane does not
            // follow, and the bridge says so rather than half-following it.
            rec.put("namedEntityGraphs", namedEntityGraphsOf(typeAnns));
            rec.put("line", lineOf(ct));
            rec.put("file", rel);
            sink.entities++;
            sink.add("2entity" + SEP + fqn, rec);
        }

        /** One entity attribute, as evidence: the annotations, verbatim, resolved to names. */
        Map<String, Object> attributeOf(String name, Tree type, List<AnnotationTree> anns, int line) {
            List<String> names = annotationNames(anns);
            AnnotationTree column = annNamed(anns, "Column");
            AnnotationTree join = annNamed(anns, "JoinColumn");
            AnnotationTree joinTable = annNamed(anns, "JoinTable");
            String relation = null;
            AnnotationTree rel = null;
            for (String[] pair : RELATION_ANNOTATIONS) {
                AnnotationTree a = annNamed(anns, pair[0]);
                if (a != null) { relation = pair[1]; rel = a; break; }
            }
            List<String> args = typeArgSimples(type);

            Map<String, Object> at = new LinkedHashMap<>();
            at.put("name", name);
            at.put("typeSimple", typeSimpleName(type));
            // The TARGET of a collection association (`List<Pet> pets` -> "Pet").
            // Emitted separately so the bridge never has to re-parse a type name.
            at.put("typeArgSimple", args.isEmpty() ? null : args.get(0));
            // …and every argument, in order (javafacts/21): a `Map<PetType, Pet>`'s
            // other side is its VALUE type, the last one, not the first.
            at.put("typeArgSimples", args);
            at.put("line", line);
            at.put("column", (column != null) ? firstString(annAttr(column, "name")) : null);
            at.put("id", names.contains("Id") || names.contains("EmbeddedId"));
            at.put("transient", names.contains("Transient"));
            at.put("relation", relation);
            at.put("mappedBy", (rel != null) ? firstString(annAttr(rel, "mappedBy")) : null);
            // WHEN THE ROW ON THE OTHER SIDE IS LOADED (javafacts/10). Written
            // down or not written down, and nothing more: `fetch = FetchType.EAGER`
            // is "EAGER", an annotation that leaves it out is null. What null MEANS
            // is the JPA specification's default and it depends on the relation
            // kind, so src/adapters/jpa_bridge.mjs decides it, not this file.
            at.put("fetch", (rel != null) ? fetchTypeOf(annAttr(rel, "fetch")) : null);
            // `targetEntity = Pet.class`, when the mapping spells the other side out
            // instead of leaving it to the field's type. `typeArgSimple` already
            // carries the generic argument, so this is the OTHER way of writing it.
            at.put("targetEntity", (rel != null) ? classLiteralSimpleName(annAttr(rel, "targetEntity")) : null);
            at.put("cascade", (rel != null) ? memberNames(annAttr(rel, "cascade")) : new ArrayList<String>());
            at.put("joinColumn", (join != null) ? firstString(annAttr(join, "name")) : null);
            // Every join column the attribute writes, each with the column it
            // references (javafacts/23): one @JoinColumn, or each one inside
            // @JoinColumns. A composite foreign key is named column by column.
            AnnotationTree joins = annNamed(anns, "JoinColumns");
            List<Object> joinCols = new ArrayList<>();
            if (join != null) joinCols.add(joinColumnOf(join));
            else if (joins != null) collectJoinColumns(annAttr(joins, "value"), joinCols);
            at.put("joinColumns", joinCols);
            // `@MapsId("postsId")` names the id attribute this association maps;
            // an empty one is "" (the whole id), and no @MapsId is null.
            AnnotationTree mapsId = annNamed(anns, "MapsId");
            if (mapsId != null) {
                String v = firstString(annAttr(mapsId, "value"));
                at.put("mapsId", v == null ? "" : v);
            } else {
                at.put("mapsId", null);
            }
            // What @AttributeOverride(s) on the attribute rename, by attribute path.
            at.put("attributeOverrides", attributeOverridesOf(anns));
            if (joinTable != null) {
                Map<String, Object> jt = new LinkedHashMap<>();
                jt.put("name", firstString(annAttr(joinTable, "name")));
                jt.put("joinColumns", joinColumnNames(annAttr(joinTable, "joinColumns")));
                jt.put("inverseJoinColumns", joinColumnNames(annAttr(joinTable, "inverseJoinColumns")));
                at.put("joinTable", jt);
            } else {
                at.put("joinTable", null);
            }
            at.put("embedded", names.contains("Embedded") || names.contains("EmbeddedId"));
            // Values kept in a collection table of their own (javafacts/21), not a
            // column of this entity's table.
            at.put("elementCollection", names.contains("ElementCollection"));
            // Every annotation's name, as written (javafacts/21): the bridge says
            // which ones it does not read, rather than reading past them.
            at.put("annotations", names);
            // …and each one's type as the source writes it (javafacts/23), so an
            // annotation the tree declares is found the way javac finds it.
            at.put("annotationsWritten", annotationsWritten(anns));
            return at;
        }

        // ---- Spring Data: `repository` records ------------------------------
        // An interface whose extends clause (javac puts an interface's `extends`
        // list in the IMPLEMENTS clause) names a Spring Data base repository.
        // `Repository` alone is far too common a simple name to trust, so that one
        // is accepted only when the file imports it from org.springframework.data.
        void emitRepository(ClassTree ct, String fqn, List<AnnotationTree> typeAnns) {
            String base = null;
            Tree baseTree = null;
            for (Tree t : ct.getImplementsClause()) {
                String s = typeSimpleName(t);
                if (s == null) continue;
                boolean known = false;
                for (String b : REPOSITORY_BASES) if (b.equals(s)) known = true;
                if (!known) continue;
                String imported = imports.get(s);
                if ("Repository".equals(s) && (imported == null || !imported.startsWith("org.springframework.data."))) {
                    continue; // a `Repository` this file did not import from Spring Data
                }
                if (imported != null && !imported.startsWith("org.springframework.data.")) continue;
                base = s;
                baseTree = t;
                break;
            }
            if (base == null) return;

            List<String> args = typeArgSimples(baseTree);
            List<Object> methods = new ArrayList<>();
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof MethodTree)) continue;
                MethodTree m = (MethodTree) member;
                if (m.getBody() != null) continue; // a default method is code, not a query
                List<AnnotationTree> ma = annotationsOf(m.getModifiers().getAnnotations());
                List<String> params = new ArrayList<>();
                for (VariableTree p : m.getParameters()) {
                    String ps = typeSimpleName(p.getType());
                    params.add(ps == null ? p.getType().toString() : ps);
                }
                AnnotationTree q = annNamed(ma, "Query");
                Map<String, Object> query = null;
                if (q != null) {
                    String text = firstString(annAttr(q, "value"));
                    Boolean nat = boolOf(annAttr(q, "nativeQuery"));
                    query = new LinkedHashMap<>();
                    query.put("text", text);
                    query.put("native", nat != null && nat);
                }
                Map<String, Object> mr = new LinkedHashMap<>();
                mr.put("name", m.getName().toString());
                mr.put("line", lineOf(m));
                mr.put("params", params);
                mr.put("query", query);
                mr.put("modifying", annotationNames(ma).contains("Modifying"));
                // The fetch plan THIS METHOD asks for (javafacts/10):
                // `@EntityGraph(attributePaths = {"pets"})` names the paths outright,
                // `@EntityGraph("Owner.pets")` names a plan the ENTITY declares. Both
                // are recorded as written; resolving the name against the entity's
                // @NamedEntityGraph is the bridge's job, because only it holds both files.
                mr.put("entityGraph", entityGraphOf(ma));
                methods.add(mr);
            }

            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("kind", "repository");
            rec.put("fqn", fqn);
            rec.put("base", base);
            rec.put("entityTypeSimple", args.size() > 0 ? args.get(0) : null);
            rec.put("idTypeSimple", args.size() > 1 ? args.get(1) : null);
            rec.put("methods", methods);
            rec.put("line", lineOf(ct));
            rec.put("file", rel);
            sink.repositories++;
            sink.add("2repo" + SEP + fqn, rec);
        }

        // ---- MyBatis-Plus: `mpEntity` records (javafacts/6) -----------------
        // MP maps a plain POJO to a table with no @Entity anywhere: the class is
        // named as the `T` of BaseMapper<T> / IService<T> / ServiceImpl<M,T>, and
        // the physical names come from a GLOBAL naming rule plus whatever
        // @TableName/@TableField spell out. THIS WORKER RECORDS ONLY WHAT THE
        // FILE SAYS. Whether `SysUser` is `sys_user`, and how sure that is, is
        // decided in src/adapters/mp_bridge.mjs against the profile (I-1/I-6).
        //
        // PER-FILE, deliberately: the fact cache shards this stream by file
        // (src/core/facts_store.mjs), so a record emitted for THIS class because
        // of what ANOTHER file declares would be wrong the moment one of the two
        // is re-read on its own. So the trigger here is an MP annotation in this
        // very file; a class named as an entity that carries none is resolved,
        // and reported, by the bridge from the mapper/service records below.
        void emitMpEntity(ClassTree ct, String fqn, List<AnnotationTree> typeAnns, List<String> annNames, String ext) {
            AnnotationTree tableName = annNamed(typeAnns, "TableName");
            boolean anyMemberAnnotation = false;
            for (Tree member : ct.getMembers()) {
                List<AnnotationTree> ma = null;
                if (member instanceof VariableTree) ma = annotationsOf(((VariableTree) member).getModifiers().getAnnotations());
                else if (member instanceof MethodTree) ma = annotationsOf(((MethodTree) member).getModifiers().getAnnotations());
                if (ma == null) continue;
                if (hasMpAnnotation(ma)) { anyMemberAnnotation = true; break; }
            }
            if (tableName == null && !anyMemberAnnotation) return;

            List<Object> fields = new ArrayList<>();
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof VariableTree)) continue;
                VariableTree v = (VariableTree) member;
                java.util.Set<Modifier> flags = v.getModifiers().getFlags();
                // MP's own rule (TableInfoHelper): a static or transient field is
                // never a column. Both are RECORDED rather than dropped, so the
                // bridge can say why a field owns no column instead of the field
                // vanishing between the source and the answer.
                boolean isStatic = flags.contains(Modifier.STATIC);
                boolean isTransient = flags.contains(Modifier.TRANSIENT);
                List<AnnotationTree> anns = annotationsOf(v.getModifiers().getAnnotations());
                List<String> names = annotationNames(anns);
                AnnotationTree tf = annNamed(anns, "TableField");
                AnnotationTree tid = annNamed(anns, "TableId");
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("name", v.getName().toString());
                f.put("typeSimple", typeSimpleName(v.getType()));
                f.put("line", lineOf(v));
                // @TableField("x") and @TableField(value="x") are the same
                // declaration; @TableId(value="x") names the id column.
                String col = (tf != null) ? firstString(annAttr(tf, "value")) : null;
                if (col == null && tid != null) col = firstString(annAttr(tid, "value"));
                f.put("column", col);
                Boolean exist = (tf != null) ? boolOf(annAttr(tf, "exist")) : null;
                f.put("exist", exist == null ? Boolean.TRUE : exist);
                f.put("id", tid != null);
                f.put("idType", (tid != null) ? firstMemberName(annAttr(tid, "type")) : null);
                f.put("logic", names.contains("TableLogic"));
                f.put("version", names.contains("Version"));
                f.put("fill", (tf != null) ? firstMemberName(annAttr(tf, "fill")) : null);
                f.put("static", isStatic);
                f.put("transient", isTransient);
                fields.add(f);
            }

            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("kind", "mpEntity");
            rec.put("fqn", fqn);
            rec.put("tableName", (tableName != null) ? firstString(annAttr(tableName, "value")) : null);
            rec.put("schema", (tableName != null) ? firstString(annAttr(tableName, "schema")) : null);
            // Declared, so the bridge never has to re-read the annotation list to
            // learn whether the table name was WRITTEN or has to be derived.
            rec.put("tableNameDeclared", tableName != null);
            rec.put("superclass", ext);
            rec.put("fields", fields);
            rec.put("line", lineOf(ct));
            rec.put("file", rel);
            sink.mpEntities++;
            sink.add("2mpentity" + SEP + fqn, rec);
        }

        // ---- MyBatis annotation SQL: `mapperAnnotationSql` (javafacts/7) ---
        //
        // `@Select("select * from t")` on a mapper interface method is a MyBatis
        // statement with no XML anywhere. The text is read in the three
        // spellings MyBatis accepts and nothing more is done with it: this
        // worker does not know what SQL is, and saying "this is a SELECT of
        // t_user" would be a reading, not a fact about the file (I-1/I-6).
        void emitMapperAnnotationSql(String fqn, String mname, MethodTree m) {
            for (String verb : MAPPER_SQL_ANNOTATIONS) {
                AnnotationTree a = annNamed(annotationsOf(m.getModifiers().getAnnotations()), verb);
                if (a == null) continue;
                String text = annotationSqlText(annAttr(a, "value"));
                if (text == null || text.trim().isEmpty()) {
                    sink.warn("mapper_annotation_sql_unreadable", rel,
                            "@" + verb + " on " + fqn + "#" + mname
                            + " carries no readable string (a constant reference, or a provider), so no statement was made for it");
                    continue;
                }
                Map<String, Object> rec = new LinkedHashMap<>();
                rec.put("kind", "mapperAnnotationSql");
                rec.put("ownerFqn", fqn);
                rec.put("method", mname);
                // LOWER CASE, matching the XML element that means the same thing,
                // so one downstream rule reads both spellings of a statement.
                rec.put("verb", verb.toLowerCase(java.util.Locale.ROOT));
                rec.put("text", text);
                rec.put("line", lineOf(m));
                rec.put("file", rel);
                sink.mapperAnnotationSql++;
                sink.add("5mapsql" + SEP + fqn + SEP + mname + SEP + verb.toLowerCase(java.util.Locale.ROOT), rec);
            }
        }

        /**
         * The text of a MyBatis statement annotation, in the three spellings the
         * framework accepts: one string literal, a `+` concatenation of literals,
         * and a `{ "a", "b" }` array. The array is joined with a SPACE, which is
         * what MyBatis itself does — joining without one would weld `where` onto
         * the line before it.
         *
         * Anything that is not a literal (a reference to a constant, an
         * expression) yields null: the value is not in this file, and inventing
         * a placeholder would put SQL in the stream that nobody wrote.
         */
        String annotationSqlText(ExpressionTree e) {
            if (e == null) return null;
            if (e instanceof LiteralTree) {
                Object v = ((LiteralTree) e).getValue();
                return (v instanceof String) ? (String) v : null;
            }
            if (e instanceof BinaryTree) {
                BinaryTree b = (BinaryTree) e;
                if (b.getKind() != Tree.Kind.PLUS) return null;
                String l = annotationSqlText(b.getLeftOperand());
                String r = annotationSqlText(b.getRightOperand());
                return (l == null || r == null) ? null : l + r;
            }
            if (e instanceof NewArrayTree) {
                List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
                if (inits == null) return null;
                StringBuilder sb = new StringBuilder();
                for (ExpressionTree it : inits) {
                    String part = annotationSqlText(it);
                    if (part == null) return null;
                    if (sb.length() > 0) sb.append(' ');
                    sb.append(part);
                }
                return sb.length() == 0 ? null : sb.toString();
            }
            return null;
        }

        // Method-invocation walk: emit a call only when the receiver is a simple
        // name that resolves to an instance field of the enclosing type.
        void scanCalls(final String fqn, final String mname, final Map<String, String> fields,
                       final String superSimple, final Map<String, String> constants, MethodTree m) {
            final String from = fqn + "#" + mname;
            final String ownSimple = fqn.substring(fqn.lastIndexOf('.') + 1);
            m.getBody().accept(new TreeScanner<Void, Void>() {
                @Override public Void visitMethodInvocation(MethodInvocationTree inv, Void p) {
                    Tree sel = inv.getMethodSelect();
                    if (sel instanceof MemberSelectTree) {
                        MemberSelectTree ms = (MemberSelectTree) sel;
                        ExpressionTree recvExpr = ms.getExpression();
                        String methodName = ms.getIdentifier().toString();
                        // `this.m()` and `super.m()` are calls the lane dropped
                        // entirely until javafacts/5 — with them went every chain
                        // that ran through a base controller's `super.exportXls(...)`
                        // or a helper reached as `this.helper()`. `this.m()` is the
                        // SAME call as the unqualified `m()`; `super.m()` names the
                        // SUPERCLASS, and which ancestor actually declares `m` is
                        // resolved later, in the bridge, from the type records.
                        String keyword = receiverKeyword(recvExpr);
                        if (keyword != null) {
                            if ("this".equals(keyword)) {
                                emitCall(from, "this", methodName, ownSimple, "this-method", inv);
                            } else {
                                emitCall(from, "super", methodName, superSimple, "super-method", inv);
                            }
                            return super.visitMethodInvocation(inv, p);
                        }
                        // `field.m()` and `this.field.m()` are the SAME call: the
                        // second spelling was silently dropped until javafacts/3,
                        // which lost every `this.repo.save(x)` in a Spring project.
                        String recv = receiverFieldName(recvExpr);
                        if (recv != null) {
                            String toType = fields.get(recv);
                            if (toType != null) {
                                // The SPELLING is recorded (`x.m()` vs `this.x.m()`)
                                // even though both resolve through the same field.
                                // Downstream turns it into the rule that made the
                                // edge, so a reader can see what the resolution
                                // rested on instead of taking one grade on faith.
                                emitCall(from, recv, methodName, toType,
                                        (recvExpr instanceof IdentifierTree) ? "field" : "this-field", inv);
                            } else if (declaredNames.contains(recv)) {
                                // a receiver THIS FILE declares (a local, a
                                // parameter, or a field whose type is a primitive
                                // or otherwise unusable): honest skip, as before,
                                // and now counted under its own name.
                                sink.skippedCalls++;
                                sink.skippedLocalReceivers++;
                            } else {
                                // A receiver NOTHING in this file declares. In Java
                                // that name resolves to a member INHERITED from a
                                // supertype — whose declaration is in another file,
                                // which a parse-only per-file worker may not read.
                                // The name is the evidence; `toTypeSimple` stays
                                // null because this worker knows no type for it,
                                // and the bridge resolves it against the type
                                // records it holds for the whole tree (I-1/I-6).
                                emitCall(from, recv, methodName, null, "identifier", inv);
                            }
                        }
                        // chained/qualified receivers (a.b().c(), Type.x()) are not
                        // simple-name receivers: skipped silently, not counted.
                    } else if (sel instanceof IdentifierTree) {
                        // An UNQUALIFIED call `m(...)`: in Java that is a method of
                        // the enclosing type or one it inherits — never a free
                        // function. Recorded as a call ON THE ENCLOSING TYPE, which
                        // is what keeps a chain alive through a controller's private
                        // helper. A statically imported name is NOT such a call, so
                        // it is skipped rather than mis-attributed.
                        String methodName = ((IdentifierTree) sel).getName().toString();
                        if (staticImportNames.contains(methodName) || staticImportNames.contains("*")) {
                            sink.skippedCalls++;
                        } else if (!"this".equals(methodName) && !"super".equals(methodName)) {
                            emitCall(from, "this", methodName, ownSimple, "unqualified", inv);
                        }
                    }
                    return super.visitMethodInvocation(inv, p);
                }

                void emitCall(String fromMember, String recv, String methodName, String toType, String via,
                              MethodInvocationTree inv) {
                    Map<String, Object> cr = new LinkedHashMap<>();
                    cr.put("kind", "call");
                    cr.put("from", fromMember);
                    cr.put("receiver", recv);
                    cr.put("method", methodName);
                    cr.put("toTypeSimple", toType);
                    cr.put("via", via);
                    // A MYBATIS STATEMENT ID, WHEN THIS CALL COULD CARRY ONE
                    // (javafacts/11). Only for the ten session methods, and only
                    // as far as ONE FILE can read it: a string literal, or a
                    // `static final String` of this same class. `stmtArg` is what
                    // was written when neither applies, so the run can say how
                    // many statement calls it could not read and what they looked
                    // like, instead of reporting a smaller number with no reason.
                    if (STATEMENT_METHODS.contains(methodName)) {
                        List<? extends ExpressionTree> args = inv.getArguments();
                        ExpressionTree first = (args != null && !args.isEmpty()) ? unwrap(args.get(0)) : null;
                        String id = statementIdOf(first, constants);
                        if (id != null) {
                            cr.put("stmtId", id);
                            cr.put("stmtIdFrom", (first instanceof IdentifierTree) ? "constant" : "literal");
                        } else if (first != null) {
                            cr.put("stmtArg", shortExpression(first));
                            String bare = bareStatementIdOf(first, constants);
                            if (bare != null) {
                                cr.put("stmtIdBare", bare);
                                cr.put("stmtIdFrom", (first instanceof IdentifierTree) ? "constant" : "literal");
                            }
                        }
                        cr.put("line", lineOf(inv));
                    }
                    cr.put("file", rel);
                    sink.calls++;
                    sink.add("6call" + SEP + fromMember + SEP + recv + SEP + methodName + SEP
                            + toType + SEP + via + SEP + Integer.toString(sink.calls), cr);
                }
            }, null);
        }


        // ---- functional routes: `routeFunction` records (javafacts/17) -----
        //
        // Spring's functional endpoints declare a route with CALLS, not with an
        // annotation: `route().GET("/owners/{id}", handler::show).build()`. The
        // one thing that marks such code in a single file is the type the method
        // is declared to return, a RouterFunction. So the body of every method
        // declared to return one is recorded as a tree of what it is written
        // with: calls, strings, method references, lambdas, names.
        //
        // IT DECIDES NOTHING. Which call names a verb, which argument is the
        // path and which the handler, and how a nest prefixes what is under it,
        // are the rule pack's (src/core/rules/packs/spring-functional.json, read
        // by src/core/rules/kinds/java_route_function.mjs). A tree past its
        // budget, or a string past its length, is marked cut rather than
        // recorded in part, so a reader can say what it did not see.
        /**
         * ONE `@Bean` METHOD (javafacts/24): its return type and parameter types
         * as written, and the types its own body constructs with `new`. Whether
         * the bean is an EntityManagerFactory, built by hand or from Spring Boot's
         * builder, is the jpa rule pack's question; this records what it reads.
         */
        void emitBeanMethod(String fqn, String mname, MethodTree m) {
            List<Object> params = new ArrayList<>();
            for (VariableTree v : m.getParameters()) params.add(writtenName(v.getType()));
            final java.util.LinkedHashSet<String> constructs = new java.util.LinkedHashSet<>();
            if (m.getBody() != null) {
                m.getBody().accept(new TreeScanner<Void, Void>() {
                    @Override public Void visitNewClass(NewClassTree nc, Void p) {
                        String w = writtenName(nc.getIdentifier());
                        if (w != null) constructs.add(w);
                        return super.visitNewClass(nc, p);
                    }
                }, null);
            }
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("kind", "beanMethod");
            r.put("owner", fqn);
            r.put("name", mname);
            r.put("returns", writtenName(m.getReturnType()));
            r.put("params", params);
            r.put("constructs", new ArrayList<Object>(constructs));
            r.put("line", lineOf(m));
            r.put("file", rel);
            sink.add("5beanMethod" + SEP + fqn + "#" + mname + SEP + lineOf(m), r);
        }

        /** Whether a class declares a method annotated @Bean. */
        boolean declaresBeanMethod(ClassTree ct) {
            for (Tree member : ct.getMembers()) {
                if (member instanceof MethodTree
                        && annotationNames(((MethodTree) member).getModifiers().getAnnotations()).contains("Bean")) return true;
            }
            return false;
        }

        /**
         * THE PROPERTY KEYS A CONFIGURATION CLASS PUTS (javafacts/24): every
         * `put`, `putIfAbsent` or `setProperty` call with two arguments in the
         * class's own methods (lambdas and anonymous classes in them too) whose
         * key is a string literal or a name, with the value as far as its form
         * says it: a literal, `X.class` (or its name), `new X()`, or a name.
         * Which key is a Hibernate naming setting is the jpa rule pack's.
         */
        void emitPropertyKeys(String fqn, ClassTree ct) {
            final List<Object> keys = new ArrayList<>();
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof MethodTree)) continue;
                final String method = ((MethodTree) member).getName().toString();
                member.accept(new TreeScanner<Void, Void>() {
                    @Override public Void visitMethodInvocation(MethodInvocationTree inv, Void p) {
                        Map<String, Object> k = propertyKeyOf(inv, method);
                        if (k != null) keys.add(k);
                        return super.visitMethodInvocation(inv, p);
                    }
                }, null);
            }
            if (keys.isEmpty()) return;
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("kind", "propertyKeys");
            r.put("owner", fqn);
            r.put("keys", keys);
            r.put("file", rel);
            sink.add("9propertyKeys" + SEP + fqn, r);
        }

        /** One `put(key, value)`-shaped call as a record, or null when it is not one or its key is neither a literal nor a name. */
        Map<String, Object> propertyKeyOf(MethodInvocationTree inv, String method) {
            Tree sel = inv.getMethodSelect();
            String name = sel instanceof MemberSelectTree ? ((MemberSelectTree) sel).getIdentifier().toString()
                    : sel instanceof IdentifierTree ? ((IdentifierTree) sel).getName().toString() : null;
            if (!("put".equals(name) || "putIfAbsent".equals(name) || "setProperty".equals(name))) return null;
            if (inv.getArguments().size() != 2) return null;
            String[] key = valueForm(inv.getArguments().get(0));
            if (key == null || !("literal".equals(key[0]) || "name".equals(key[0]))) return null;
            String[] value = valueForm(inv.getArguments().get(1));
            Map<String, Object> k = new LinkedHashMap<>();
            k.put("method", method);
            k.put("key", key[1]);
            k.put("keyForm", key[0]);
            k.put("value", value == null ? null : value[1]);
            k.put("valueForm", value == null ? null : value[0]);
            k.put("line", lineOf(inv));
            return k;
        }

        /** An argument's form and text: a string literal, `X.class` or its name, `new X()`, a name; null for anything else. */
        String[] valueForm(ExpressionTree arg) {
            if (arg instanceof LiteralTree) {
                Object v = ((LiteralTree) arg).getValue();
                return v instanceof String ? new String[] { "literal", (String) v } : null;
            }
            if (arg instanceof NewClassTree) {
                NewClassTree nc = (NewClassTree) arg;
                String w = nc.getClassBody() == null ? writtenName(nc.getIdentifier()) : null;
                return w == null ? null : new String[] { "new", w };
            }
            ExpressionTree e = arg;
            // `X.class.getName()` and its kin name the class `X.class` does.
            if (e instanceof MethodInvocationTree && ((MethodInvocationTree) e).getArguments().isEmpty()
                    && ((MethodInvocationTree) e).getMethodSelect() instanceof MemberSelectTree) {
                e = ((MemberSelectTree) ((MethodInvocationTree) e).getMethodSelect()).getExpression();
            }
            if (e instanceof MemberSelectTree && "class".equals(((MemberSelectTree) e).getIdentifier().toString())) {
                String w = writtenName(((MemberSelectTree) e).getExpression());
                return w == null ? null : new String[] { "class", w };
            }
            if (e != arg) return null;
            if (arg instanceof MemberSelectTree || arg instanceof IdentifierTree) return new String[] { "name", arg.toString() };
            return null;
        }

        void emitRouteFunction(String fqn, String mname, MethodTree m, Map<String, String> classConstants) {
            if (m.getBody() == null) return;
            String ret = typeSimpleName(m.getReturnType());
            if (ret == null) return;
            // …or one that returns something HOLDING one, `Supplier<RouterFunction<…>>`:
            // a helper that hands a nest its routes. The outer type is recorded, so
            // nothing downstream takes such a method for a router function itself.
            String wrapper = null;
            if (!ROUTE_FUNCTION_TYPES.contains(ret)) {
                String inner = null;
                for (String a : typeArgSimples(m.getReturnType())) {
                    if (a != null && ROUTE_FUNCTION_TYPES.contains(a)) { inner = a; break; }
                }
                if (inner == null) return;
                wrapper = ret;
                ret = inner;
            }
            // The class's `static final String` fields initialised with a literal:
            // a path is as often `GET(UNSUBSCRIBE_PATTERN, ...)` as a literal, and
            // the value is on the line that declares it, in this file.
            Map<String, Object> constants = new java.util.TreeMap<>();
            for (Map.Entry<String, String> c : classConstants.entrySet()) {
                if (c.getValue().length() <= ROUTE_STRING_LIMIT) constants.put(c.getKey(), c.getValue());
            }
            List<Object> params = new ArrayList<>();
            for (VariableTree p : m.getParameters()) {
                Map<String, Object> pr = new LinkedHashMap<>();
                pr.put("name", p.getName().toString());
                pr.put("type", typeSimpleName(p.getType()));
                params.add(pr);
            }
            RouteTree rt = new RouteTree();
            List<Object> body = rt.block(m.getBody().getStatements());
            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("kind", "routeFunction");
            rec.put("owner", fqn);
            rec.put("method", mname);
            rec.put("paramCount", m.getParameters().size());
            rec.put("returnType", ret);
            rec.put("returnWrapper", wrapper);
            rec.put("annotations", annotationNames(m.getModifiers().getAnnotations()));
            rec.put("params", params);
            rec.put("constants", constants);
            rec.put("body", body);
            rec.put("cut", rt.cut);
            rec.put("line", lineOf(m));
            rec.put("file", rel);
            sink.routeFunctions++;
            sink.add("5routefn" + SEP + fqn + SEP + mname + SEP + m.getParameters().size() + SEP + pad(lineOf(m)), rec);
        }

        /** One method body as a tree, within one budget of nodes. */
        final class RouteTree {
            int nodes = 0;
            boolean cut = false;

            List<Object> block(List<? extends com.sun.source.tree.StatementTree> stmts) {
                List<Object> out = new ArrayList<>();
                for (com.sun.source.tree.StatementTree s : stmts) out.add(stmt(s));
                return out;
            }

            Map<String, Object> stmt(com.sun.source.tree.StatementTree s) {
                Map<String, Object> o = new LinkedHashMap<>();
                if (s instanceof ReturnTree) {
                    ExpressionTree e = ((ReturnTree) s).getExpression();
                    o.put("s", "return");
                    o.put("e", (e == null) ? null : expr(e));
                } else if (s instanceof VariableTree) {
                    VariableTree v = (VariableTree) s;
                    o.put("s", "var");
                    o.put("n", v.getName().toString());
                    // null for `var`: the declared type is then the initializer's
                    o.put("t", typeSimpleName(v.getType()));
                    o.put("e", (v.getInitializer() == null) ? null : expr(v.getInitializer()));
                } else if (s instanceof com.sun.source.tree.ExpressionStatementTree
                        && isLocalAssignment(((com.sun.source.tree.ExpressionStatementTree) s).getExpression())) {
                    // `prefix = "/actual";` (javafacts/18): a local holds a new
                    // value from here on, so a later use reads this one.
                    AssignmentTree as = (AssignmentTree) unwrap(((com.sun.source.tree.ExpressionStatementTree) s).getExpression());
                    o.put("s", "assign");
                    o.put("n", ((IdentifierTree) as.getVariable()).getName().toString());
                    o.put("e", expr(as.getExpression()));
                    putAssigned(o, as.getExpression());
                } else if (s instanceof com.sun.source.tree.ExpressionStatementTree) {
                    o.put("s", "expr");
                    o.put("e", expr(((com.sun.source.tree.ExpressionStatementTree) s).getExpression()));
                    putAssigned(o, s);
                } else {
                    // an if, a loop, a try: what is built in it is not read
                    o.put("s", "other");
                    o.put("t", s.getKind().name());
                    putAssigned(o, s);
                    putCalled(o, s);
                }
                if (s instanceof ReturnTree || s instanceof VariableTree) putAssigned(o, s);
                o.put("l", lineOf(s));
                return o;
            }

            /** Whether an expression is `name = value`, a plain assignment to a simple name. */
            boolean isLocalAssignment(ExpressionTree e) {
                ExpressionTree x = unwrap(e);
                return x instanceof AssignmentTree && ((AssignmentTree) x).getVariable() instanceof IdentifierTree;
            }

            /**
             * The simple names a statement assigns anywhere inside it, apart
             * from the one plain assignment it is (javafacts/18): in a branch,
             * with `+=`, with `++`, or nested in an expression. The reader does
             * not follow those, so a local among them holds a value it cannot
             * name from there on.
             */
            void putAssigned(Map<String, Object> o, Tree t) {
                final java.util.TreeSet<String> names = new java.util.TreeSet<>();
                t.accept(new TreeScanner<Void, Void>() {
                    void target(ExpressionTree v) { if (v instanceof IdentifierTree) names.add(((IdentifierTree) v).getName().toString()); }
                    @Override public Void visitAssignment(AssignmentTree a, Void p) { target(a.getVariable()); return super.visitAssignment(a, p); }
                    @Override public Void visitCompoundAssignment(com.sun.source.tree.CompoundAssignmentTree a, Void p) { target(a.getVariable()); return super.visitCompoundAssignment(a, p); }
                    @Override public Void visitUnary(com.sun.source.tree.UnaryTree u, Void p) {
                        switch (u.getKind()) {
                            case PREFIX_INCREMENT: case PREFIX_DECREMENT: case POSTFIX_INCREMENT: case POSTFIX_DECREMENT:
                                target(u.getExpression());
                                break;
                            default:
                        }
                        return super.visitUnary(u, p);
                    }
                }, null);
                if (!names.isEmpty()) o.put("a", new ArrayList<Object>(names));
            }

            List<Object> exprs(List<? extends ExpressionTree> es) {
                List<Object> out = new ArrayList<>();
                for (ExpressionTree a : es) out.add(expr(a));
                return out;
            }

            Map<String, Object> expr(ExpressionTree e0) {
                ExpressionTree e = unwrap(e0);
                Map<String, Object> o = new LinkedHashMap<>();
                if (++nodes > ROUTE_TREE_BUDGET) {
                    cut = true;
                    o.put("k", "cut");
                    return o;
                }
                if (e instanceof MethodInvocationTree) return call((MethodInvocationTree) e, o);
                if (e instanceof LiteralTree) return literal((LiteralTree) e, o);
                if (e instanceof BinaryTree && e.getKind() == Tree.Kind.PLUS) return plus(e, o);
                if (e instanceof IdentifierTree) {
                    String n = ((IdentifierTree) e).getName().toString();
                    if ("this".equals(n) || "super".equals(n)) o.put("k", n);
                    else { o.put("k", "id"); o.put("v", n); }
                    return o;
                }
                if (e instanceof MemberSelectTree) {
                    o.put("k", "sel");
                    o.put("v", writtenText(e));
                    return o;
                }
                if (e instanceof MemberReferenceTree) {
                    MemberReferenceTree mr = (MemberReferenceTree) e;
                    o.put("k", "ref");
                    o.put("r", expr(mr.getQualifierExpression()));
                    o.put("n", mr.getName().toString());
                    return o;
                }
                if (e instanceof com.sun.source.tree.LambdaExpressionTree) return lambda((com.sun.source.tree.LambdaExpressionTree) e, o);
                if (e instanceof NewClassTree) {
                    NewClassTree nc = (NewClassTree) e;
                    o.put("k", "new");
                    o.put("t", typeSimpleName(nc.getIdentifier()));
                    o.put("a", exprs(nc.getArguments()));
                    return o;
                }
                o.put("k", "other");
                o.put("t", (e == null) ? null : e.getKind().name());
                if (e != null) putCalled(o, e);
                return o;
            }

            /**
             * The names of the methods called anywhere inside a statement or an
             * expression this tree does not record whole (javafacts/20): an if,
             * a loop, a conditional expression. The reader cannot follow what
             * they do, but it can see that `operationId` may be called in one.
             */
            void putCalled(Map<String, Object> o, Tree t) {
                final java.util.TreeSet<String> names = new java.util.TreeSet<>();
                t.accept(new TreeScanner<Void, Void>() {
                    @Override public Void visitMethodInvocation(MethodInvocationTree inv, Void p) {
                        Tree sel = inv.getMethodSelect();
                        if (sel instanceof MemberSelectTree) names.add(((MemberSelectTree) sel).getIdentifier().toString());
                        else if (sel instanceof IdentifierTree) names.add(((IdentifierTree) sel).getName().toString());
                        return super.visitMethodInvocation(inv, p);
                    }
                }, null);
                if (!names.isEmpty()) o.put("c", new ArrayList<Object>(names));
            }

            Map<String, Object> call(MethodInvocationTree inv, Map<String, Object> o) {
                Tree sel = inv.getMethodSelect();
                o.put("k", "call");
                if (sel instanceof MemberSelectTree) {
                    o.put("n", ((MemberSelectTree) sel).getIdentifier().toString());
                    o.put("r", expr(((MemberSelectTree) sel).getExpression()));
                } else {
                    o.put("n", (sel instanceof IdentifierTree) ? ((IdentifierTree) sel).getName().toString() : null);
                    o.put("r", null);
                }
                o.put("a", exprs(inv.getArguments()));
                // The line the call's NAME is on: a chained call starts where its
                // receiver starts, so `route()\n  .GET(...)\n  .POST(...)` would
                // otherwise put every route on the first line.
                o.put("l", nameLineOf(sel));
                return o;
            }

            Map<String, Object> literal(LiteralTree lt, Map<String, Object> o) {
                Object v = lt.getValue();
                if (!(v instanceof String)) { o.put("k", "lit"); return o; }
                o.put("k", "str");
                String s = (String) v;
                if (s.length() > ROUTE_STRING_LIMIT) { o.put("v", null); o.put("cut", true); }
                else o.put("v", s);
                return o;
            }

            /** `"/a" + "/b"` is one string; `"/apis/" + gv` keeps its parts. */
            Map<String, Object> plus(ExpressionTree e, Map<String, Object> o) {
                String folded = annotationSqlText(e);
                if (folded != null && folded.length() <= ROUTE_STRING_LIMIT) {
                    o.put("k", "str");
                    o.put("v", folded);
                    return o;
                }
                List<ExpressionTree> parts = new ArrayList<>();
                flattenPlus(e, parts);
                o.put("k", "plus");
                o.put("a", exprs(parts));
                return o;
            }

            Map<String, Object> lambda(com.sun.source.tree.LambdaExpressionTree le, Map<String, Object> o) {
                List<String> ps = new ArrayList<>();
                for (VariableTree p : le.getParameters()) ps.add(p.getName().toString());
                o.put("k", "lambda");
                o.put("p", ps);
                Tree body = le.getBody();
                if (body instanceof com.sun.source.tree.BlockTree) {
                    o.put("b", block(((com.sun.source.tree.BlockTree) body).getStatements()));
                } else {
                    o.put("e", expr((ExpressionTree) body));
                }
                return o;
            }
        }

        // ---- imperative HTTP calls: `httpCall` records (javafacts/8) --------
        //
        // A DECLARATIVE client says where it is going in an annotation, and the
        // `client` field on the type record above carries it. Most
        // service-to-service traffic is not written that way. It is a fluent
        // chain (`webClient.get().uri("http://svc.invalid/a/{id}", x).retrieve()`) or a
        // RestTemplate call (`restTemplate.getForObject(url, X.class)`), where
        // the VERB is a method name and the URL is an argument. Until
        // javafacts/8 the lane saw none of it, so a five-service application
        // whose gateway calls the other four with a WebClient produced no
        // cross-service edge at all.
        //
        // WHAT TRIGGERS THE SCAN, and why it is that and not a name:
        //   - RestTemplate: the receiver's DECLARED TYPE. `execute` and `put`
        //     and `delete` are ordinary method names, so a thread pool's
        //     `pool.execute(task)` must never be read as an HTTP request; only
        //     a receiver this file declares as a RestTemplate/RestOperations
        //     gets there.
        //   - WebClient/RestClient: the SHAPE. A builder chain often starts at
        //     an expression whose type no single file states
        //     (`webClientBuilder.build().get()`), so the chain itself is the
        //     evidence: a verb call, a `.uri(...)`, and the call that sends it.
        //     Both must be present, which is what keeps it off ordinary code.
        //
        // IT DECIDES NOTHING. The url is recorded as far as one file can read
        // it and no further: a literal, a literal with `{…}` placeholders, or a
        // concatenation whose literal halves are kept and whose base is named
        // as unreadable. A url this scan cannot reduce to a path is recorded
        // `unresolved` WITH THE EXPRESSION AS WRITTEN, never guessed into a
        // route. Whether the path names a route this pack serves is decided in
        // src/adapters/java_bridge.mjs (I-1/I-6).
        void scanHttpCalls(final String fqn, final String mname,
                           final Map<String, String> fieldTypeWritten, MethodTree m) {
            final String from = fqn + "#" + mname;
            // Every name this METHOD binds, by its written type: a client is as
            // often a local or a parameter as an injected field. Collected in
            // its own pass so a call before the declaration reads the same as
            // one after it.
            final Map<String, String> localTypes = new LinkedHashMap<>();
            for (VariableTree p : m.getParameters()) {
                String w = typeWrittenName(p.getType());
                if (w != null) localTypes.put(p.getName().toString(), w);
            }
            m.getBody().accept(new TreeScanner<Void, Void>() {
                @Override public Void visitVariable(VariableTree v, Void p) {
                    String w = typeWrittenName(v.getType());
                    if (w != null) localTypes.put(v.getName().toString(), w);
                    return super.visitVariable(v, p);
                }
            }, null);

            m.getBody().accept(new TreeScanner<Void, Void>() {
                @Override public Void visitMethodInvocation(MethodInvocationTree inv, Void p) {
                    Tree sel = inv.getMethodSelect();
                    if (sel instanceof MemberSelectTree) {
                        MemberSelectTree ms = (MemberSelectTree) sel;
                        String name = ms.getIdentifier().toString();
                        ExpressionTree recv = unwrap(ms.getExpression());
                        String recvName = receiverFieldName(recv);
                        String recvType = typeOfName(recvName);
                        if ("resttemplate".equals(httpClientKindOf(recvType))) {
                            restTemplateCall(inv, name, recvName, recvType);
                        } else if (FLUENT_TERMINALS.contains(name)) {
                            fluentChain(inv);
                        }
                    }
                    return super.visitMethodInvocation(inv, p);
                }

                /** The written type of a name this method or this class binds, or null. */
                String typeOfName(String name) {
                    if (name == null) return null;
                    String local = localTypes.get(name);
                    return (local != null) ? local : fieldTypeWritten.get(name);
                }

                /** One RestTemplate request: the method name says the verb, argument 0 the url. */
                void restTemplateCall(MethodInvocationTree inv, String name, String recvName, String recvType) {
                    String verb = REST_TEMPLATE_VERBS.get(name);
                    if (verb == null || inv.getArguments().isEmpty()) return;
                    String httpMethod = verb;
                    if (verb.isEmpty()) {
                        // `exchange(url, HttpMethod.POST, …)` / `execute(url, HttpMethod.GET, …)`:
                        // the verb is an ARGUMENT, and one this file may not be able to read.
                        httpMethod = (inv.getArguments().size() > 1)
                                ? httpMethodArgOf(inv.getArguments().get(1)) : null;
                    }
                    emitHttpCall("resttemplate", recvName, recvType, httpMethod,
                            inv.getArguments().get(0), lineOf(inv));
                }

                /**
                 * The fluent chain that ends at the call which SENDS it, read
                 * from the outside in: the first `.uri(...)` carries the url and
                 * the first verb call names the method. Both are required.
                 */
                void fluentChain(MethodInvocationTree terminal) {
                    ExpressionTree cur = unwrap(((MemberSelectTree) terminal.getMethodSelect()).getExpression());
                    String httpMethod = null;
                    MethodInvocationTree uriCall = null;
                    ExpressionTree root = null;
                    for (int i = 0; i < FLUENT_CHAIN_LIMIT && cur != null; i++) {
                        if (!(cur instanceof MethodInvocationTree)) { root = cur; break; }
                        MethodInvocationTree step = (MethodInvocationTree) cur;
                        Tree ssel = step.getMethodSelect();
                        if (!(ssel instanceof MemberSelectTree)) break;
                        MemberSelectTree sms = (MemberSelectTree) ssel;
                        String sname = sms.getIdentifier().toString();
                        if (uriCall == null && FLUENT_URI_METHODS.contains(sname) && !step.getArguments().isEmpty()) {
                            uriCall = step;
                        }
                        if (httpMethod == null) {
                            String v = fluentVerbOf(sname, step);
                            if (v != null) httpMethod = v;
                        }
                        cur = unwrap(sms.getExpression());
                    }
                    if (uriCall == null || httpMethod == null) return;
                    String recvName = receiverFieldName(root);
                    String recvType = typeOfName(recvName);
                    String kind = httpClientKindOf(recvType);
                    emitHttpCall(kind, recvName, recvType, httpMethod,
                            uriCall.getArguments().get(0), lineOf(terminal));
                }

                void emitHttpCall(String clientKind, String recvName, String recvType,
                                  String httpMethod, ExpressionTree urlExpr, int line) {
                    UrlRead u = readUrl(urlExpr);
                    String host = null;
                    String query = null;
                    String pathStr = null;
                    if (u.value != null) {
                        String[] hp = splitHost(u.value);
                        host = hp[0];
                        String rest = hp[1];
                        int hash = rest.indexOf('#');
                        if (hash >= 0) rest = rest.substring(0, hash);
                        int q = rest.indexOf('?');
                        if (q >= 0) { query = rest.substring(q + 1); rest = rest.substring(0, q); }
                        pathStr = joinPath(null, rest);
                    }
                    Map<String, Object> rec = new LinkedHashMap<>();
                    rec.put("kind", "httpCall");
                    rec.put("from", from);
                    // Which of the three clients it is, when the receiver's type
                    // says so; null for a builder chain whose type no line of
                    // this file states. The SHAPE is the evidence either way.
                    rec.put("client", clientKind);
                    rec.put("receiver", recvName);
                    rec.put("receiverType", recvType);
                    rec.put("httpMethod", httpMethod);
                    rec.put("urlKind", u.kind);
                    rec.put("url", u.value);
                    // The expression AS WRITTEN, which is the whole of what an
                    // unresolved url has to show for itself.
                    rec.put("written", u.written);
                    rec.put("host", host);
                    rec.put("hostLiteral", host != null && !host.contains(URL_HOLE));
                    rec.put("base", u.base);
                    rec.put("path", pathStr);
                    rec.put("query", query);
                    rec.put("line", line);
                    rec.put("file", rel);
                    sink.httpCalls++;
                    sink.add("8httpcall" + SEP + from + SEP + pad(line) + SEP
                            + (httpMethod == null ? "" : httpMethod) + SEP
                            + (pathStr == null ? "" : pathStr) + SEP + Integer.toString(sink.httpCalls), rec);
                }
            }, null);
        }

        // ---- the page a handler RENDERS: `view` records (javafacts/9) -------
        //
        // A `@Controller` that is not a `@RestController` answers a request by
        // naming a VIEW, and a template engine turns that name into the page the
        // browser gets. The name is a string in the method, so it is readable
        // here; which file it resolves to depends on the view resolver's prefix
        // and suffix, which are a project's configuration and not this file's
        // business (src/core/discover.mjs reads them, src/adapters/web_bridge.mjs
        // joins the two).
        //
        // FOUR PLACES A NAME IS WRITTEN, and one honest gap. A returned literal,
        // each literal leaf of a returned ternary, `new ModelAndView("x", …)` and
        // `mav.setViewName("x")` are read, and so are the two shapes a name can
        // take INSIDE THIS CLASS: a `static final String` field initialised with
        // a literal (`from: "constant"`), and a private or package-private method
        // of this class whose every return is such a literal or such a field
        // (`from: "helper"`, with the method's name). Both are read from this
        // file alone: the field's initializer and the helper's returns are right
        // here, so nothing is resolved across a file and nothing is a guess. The
        // helper is read ONE LEVEL DEEP — a return inside it that is itself a
        // call is not followed, and the whole helper is then unreadable.
        //
        // Anything else a returned NAME could be — a field of a superclass, a
        // method somebody overrides, a constant from another file, a local
        // variable — is not: resolving it is a data-flow or a cross-file
        // question this parse-only worker does not answer, so it is COUNTED in
        // `unresolved` and the run says how many pages it could not name.
        //
        // `redirect:` and `forward:` are not pages at all. They are recorded with
        // their kind, because what they name is a ROUTE, and the bridge turns
        // them into a call onto that route rather than into a screen.
        void scanViews(final String fqn, final String mname, final int paramCount, MethodTree m,
                       final Map<String, String> viewConstants, final Map<String, MethodTree> viewHelpers) {
            final List<Map<String, Object>> views = new ArrayList<>();
            final java.util.Set<String> seen = new java.util.LinkedHashSet<>();
            final int[] unresolved = { 0 };
            // `ModelAndView mav = new ModelAndView("x"); …; return mav;` is ONE
            // view, written the long way. The `return mav` is a name, so the rule
            // below would count it as a page this worker could not name — while
            // the page is right there on the line that built it. So a returned
            // NAME is held back and only counted when nothing in the method named
            // a view through a ModelAndView at all.
            final int[] returnedNames = { 0 };
            final boolean[] namedByModelAndView = { false };

            m.getBody().accept(new TreeScanner<Void, Void>() {
                void addView(String raw, String from) { addView(raw, from, null); }

                void addView(String raw, String from, String helper) {
                    if (raw == null) { unresolved[0]++; return; }
                    String name = raw;
                    String kind = "view";
                    if (name.startsWith("redirect:")) { kind = "redirect"; name = name.substring("redirect:".length()); }
                    else if (name.startsWith("forward:")) { kind = "forward"; name = name.substring("forward:".length()); }
                    if (name.isEmpty()) return;
                    if (!seen.add(kind + SEP + name + SEP + from)) return;
                    Map<String, Object> v = new LinkedHashMap<>();
                    v.put("name", name);
                    v.put("kind", kind);
                    v.put("from", from);
                    // WHICH method the name was read out of, when it was not this
                    // one. The bridge puts it on the edge, so a reader is never
                    // shown a page without being told where its name came from.
                    if (helper != null) v.put("helper", helper);
                    views.add(v);
                }

                /**
                 * The view names a private helper of this class returns, or null
                 * when any one of its returns is something this file cannot read.
                 * ONE LEVEL: a return that is itself a call is what makes it null.
                 */
                List<String> helperViews(MethodTree helper) {
                    final List<String> out = new ArrayList<>();
                    final boolean[] ok = { true };
                    helper.getBody().accept(new TreeScanner<Void, Void>() {
                        @Override public Void visitReturn(ReturnTree r, Void p2) {
                            ExpressionTree e = unwrap(r.getExpression());
                            if (e == null) return null;              // `return;` in a void branch
                            if (e instanceof LiteralTree && ((LiteralTree) e).getValue() instanceof String) {
                                out.add((String) ((LiteralTree) e).getValue());
                                return null;
                            }
                            if (e instanceof IdentifierTree) {
                                String v = viewConstants.get(((IdentifierTree) e).getName().toString());
                                if (v != null) { out.add(v); return null; }
                            }
                            ok[0] = false;
                            return null;
                        }
                    }, null);
                    return (ok[0] && !out.isEmpty()) ? out : null;
                }

                void readReturn(ExpressionTree e) {
                    if (e == null) return;
                    if (e instanceof LiteralTree) {
                        Object v = ((LiteralTree) e).getValue();
                        if (v instanceof String) addView((String) v, "literal");
                        return;
                    }
                    if (e instanceof ConditionalExpressionTree) {
                        readReturn(unwrap(((ConditionalExpressionTree) e).getTrueExpression()));
                        readReturn(unwrap(((ConditionalExpressionTree) e).getFalseExpression()));
                        return;
                    }
                    // `new ModelAndView("x")` and a `mav` built above are read by
                    // the two visitors below, so they are not a gap here.
                    if (e instanceof NewClassTree
                            && "ModelAndView".equals(typeSimpleName(((NewClassTree) e).getIdentifier()))) return;
                    if (e instanceof IdentifierTree) {
                        String constant = viewConstants.get(((IdentifierTree) e).getName().toString());
                        if (constant != null) { addView(constant, "constant"); return; }
                        returnedNames[0]++;
                        return;
                    }
                    if (e instanceof MethodInvocationTree) {
                        // `return addPaginationModel(page, …)` and `return
                        // this.addPaginationModel(…)` are the same call. Anything
                        // with a receiver of its own is another object's method
                        // and is not this class's to read.
                        MethodInvocationTree inv = (MethodInvocationTree) e;
                        Tree sel = inv.getMethodSelect();
                        String called = null;
                        if (sel instanceof IdentifierTree) {
                            called = ((IdentifierTree) sel).getName().toString();
                        } else if (sel instanceof MemberSelectTree
                                && "this".equals(unwrap(((MemberSelectTree) sel).getExpression()).toString())) {
                            called = ((MemberSelectTree) sel).getIdentifier().toString();
                        }
                        MethodTree helper = (called == null || called.equals(mname)) ? null : viewHelpers.get(called);
                        if (helper != null) {
                            List<String> names = helperViews(helper);
                            if (names != null) {
                                for (String n : names) addView(n, "helper", called);
                                return;
                            }
                        }
                        unresolved[0]++;
                        return;
                    }
                    if (e instanceof MemberSelectTree || e instanceof BinaryTree) {
                        unresolved[0]++;
                    }
                }

                @Override public Void visitReturn(ReturnTree r, Void p) {
                    readReturn(unwrap(r.getExpression()));
                    return super.visitReturn(r, p);
                }

                @Override public Void visitNewClass(NewClassTree nc, Void p) {
                    if ("ModelAndView".equals(typeSimpleName(nc.getIdentifier())) && !nc.getArguments().isEmpty()) {
                        namedByModelAndView[0] = true;
                        addView(firstString(unwrap(nc.getArguments().get(0))), "model-and-view");
                    }
                    return super.visitNewClass(nc, p);
                }

                @Override public Void visitMethodInvocation(MethodInvocationTree inv, Void p) {
                    Tree sel = inv.getMethodSelect();
                    if (sel instanceof MemberSelectTree
                            && "setViewName".equals(((MemberSelectTree) sel).getIdentifier().toString())
                            && !inv.getArguments().isEmpty()) {
                        namedByModelAndView[0] = true;
                        addView(firstString(unwrap(inv.getArguments().get(0))), "set-view-name");
                    }
                    return super.visitMethodInvocation(inv, p);
                }
            }, null);

            if (!namedByModelAndView[0]) unresolved[0] += returnedNames[0];
            if (views.isEmpty() && unresolved[0] == 0) return;
            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("kind", "view");
            rec.put("owner", fqn);
            rec.put("method", mname);
            rec.put("paramCount", paramCount);
            rec.put("views", views);
            rec.put("unresolved", unresolved[0]);
            rec.put("line", lineOf(m));
            rec.put("file", rel);
            sink.views++;
            sink.add("4view" + SEP + fqn + SEP + mname + SEP + paramCount, rec);
        }

        // ---- MyBatis-Plus: `mpWrapper` records (javafacts/6) ----------------
        //
        // A condition WRAPPER is where MyBatis-Plus hides the WHERE clause. There
        // is no SQL text anywhere: `new LambdaQueryWrapper<SysUserDepart>()
        // .eq(SysUserDepart::getDepId, x)` is a method reference and a value, and
        // the column it filters on only exists at run time. This scan records the
        // three things a reader would need to work it out by hand — what kind of
        // wrapper was built, for which entity type, and which operations were
        // called on it with which method references and literals — plus WHERE the
        // wrapper ended up (which mapper/service call it was handed to).
        //
        // IT DECIDES NOTHING. `eq` is recorded as the op named `eq`; that `eq`
        // means an equality predicate on a column, that `SysUserDepart::getDepId`
        // is the property `depId`, and that `depId` is the column `dep_id`, are
        // three separate readings the bridge makes against the profile and the
        // entity model (I-1/I-6). A wrapper the scan cannot see through — one
        // built by a helper such as `QueryGenerator.initQueryWrapper(request…)` —
        // is recorded with `opsComplete:false` and the name of whatever built it,
        // so the bridge can say "columns decided at run time" instead of guessing
        // or going silent.
        void scanWrappers(final String fqn, final String mname, final Map<String, String> fields, MethodTree m) {
            final String from = fqn + "#" + mname;
            final String ownSimple = fqn.substring(fqn.lastIndexOf('.') + 1);
            final Map<String, W> vars = new LinkedHashMap<>();
            final List<W> all = new ArrayList<>();
            // Tree identity -> the wrapper an expression EVALUATES TO, so a chain
            // is read once whether it is met from the outside in (as an argument)
            // or from the inside out (as a receiver).
            final java.util.IdentityHashMap<Tree, W> value = new java.util.IdentityHashMap<>();
            final java.util.IdentityHashMap<Tree, Boolean> chainDone = new java.util.IdentityHashMap<>();

            // A wrapper this method RECEIVES was built by its caller: its ops are
            // not in this file, and saying so is the whole point.
            for (VariableTree p : m.getParameters()) {
                String simple = typeSimpleName(p.getType());
                String kind = wrapperKindOf(simple);
                if (kind == null) continue;
                List<String> args = typeArgSimples(p.getType());
                W w = new W(p.getName().toString(), kind, args.isEmpty() ? null : args.get(0),
                        "parameter", null, false, lineOf(p));
                vars.put(w.var, w);
                all.add(w);
            }

            m.getBody().accept(new TreeScanner<Void, Void>() {
                @Override public Void visitVariable(VariableTree v, Void p) {
                    String declSimple = typeSimpleName(v.getType());
                    String declKind = wrapperKindOf(declSimple);
                    List<String> declArgs = typeArgSimples(v.getType());
                    ExpressionTree init = unwrap(v.getInitializer());
                    W w = null;
                    if (init instanceof NewClassTree) {
                        w = fromNew((NewClassTree) init, declKind, declArgs);
                    } else if (declKind != null && init instanceof MethodInvocationTree) {
                        // The declared type says it is a wrapper; the initializer is
                        // a call whose body is not this method. Read the chain — it
                        // may be a factory we know — and if nothing came back, the
                        // wrapper arrived already built.
                        W made = resolveChain((MethodInvocationTree) init);
                        if (made != null) {
                            w = made;
                            if (w.entitySimple == null && !declArgs.isEmpty()) w.entitySimple = declArgs.get(0);
                        } else {
                            w = new W(null, declKind, declArgs.isEmpty() ? null : declArgs.get(0),
                                    "opaque-initializer", calleeName((MethodInvocationTree) init), false, lineOf(v));
                            all.add(w);
                        }
                    } else if (declKind != null) {
                        w = new W(null, declKind, declArgs.isEmpty() ? null : declArgs.get(0),
                                init == null ? "declared-uninitialised" : "declared-type", null, init == null, lineOf(v));
                        all.add(w);
                    }
                    if (w != null) {
                        w.var = v.getName().toString();
                        vars.put(w.var, w);
                        if (init != null) value.put(init, w);
                    }
                    return super.visitVariable(v, p);
                }

                @Override public Void visitMethodInvocation(MethodInvocationTree inv, Void p) {
                    resolveChain(inv);
                    // Every ARGUMENT that is a wrapper: this call is where it went.
                    Tree sel = inv.getMethodSelect();
                    String method = null;
                    ExpressionTree recv = null;
                    if (sel instanceof MemberSelectTree) {
                        method = ((MemberSelectTree) sel).getIdentifier().toString();
                        recv = ((MemberSelectTree) sel).getExpression();
                    } else if (sel instanceof IdentifierTree) {
                        method = ((IdentifierTree) sel).getName().toString();
                    }
                    if (method != null) {
                        for (ExpressionTree arg : inv.getArguments()) {
                            W aw = wrapperOfExpr(arg);
                            if (aw == null) continue;
                            addSink(aw, recv, method, lineOf(inv));
                        }
                    }
                    return super.visitMethodInvocation(inv, p);
                }

                @Override public Void visitReturn(com.sun.source.tree.ReturnTree r, Void p) {
                    W w = wrapperOfExpr(r.getExpression());
                    if (w != null) w.sinks.add(sinkRec("returned", null, null, mname, lineOf(r)));
                    return super.visitReturn(r, p);
                }

                // ---- the chain reader -------------------------------------
                W resolveChain(MethodInvocationTree inv) {
                    if (chainDone.containsKey(inv)) return value.get(inv);
                    chainDone.put(inv, Boolean.TRUE);
                    Tree sel = inv.getMethodSelect();
                    if (!(sel instanceof MemberSelectTree)) return null;
                    MemberSelectTree ms = (MemberSelectTree) sel;
                    String method = ms.getIdentifier().toString();
                    ExpressionTree recv = unwrap(ms.getExpression());
                    W w = wrapperOfExpr(recv);
                    if (w != null) {
                        if (MP_CHAIN_TERMINALS.contains(method)) {
                            w.sinks.add(sinkRec("chain-terminal", null, w.factoryReceiverType, method, lineOf(inv)));
                            return null; // the chain's value is a result, not the wrapper
                        }
                        addOp(w, method, inv, lineOf(inv));
                        value.put(inv, w);
                        return w;
                    }
                    // A FACTORY: `Wrappers.lambdaQuery()`, or the fluent starter a
                    // service/mapper offers (`this.lambdaQuery()`), which is the
                    // only nullary form safe to read as one — `x.query(a, b)` is
                    // far too common a method name to claim.
                    String kind = factoryKindOf(method);
                    if (kind == null) return null;
                    boolean wrappersHolder = (recv instanceof IdentifierTree)
                            && "Wrappers".equals(((IdentifierTree) recv).getName().toString());
                    boolean fluentStarter = inv.getArguments().isEmpty()
                            && ("lambdaQuery".equals(method) || "lambdaUpdate".equals(method));
                    if (!wrappersHolder && !fluentStarter) return null;
                    String entity = null;
                    for (Tree ta : inv.getTypeArguments()) { entity = typeSimpleName(ta); if (entity != null) break; }
                    W made = new W(null, kind, entity, wrappersHolder ? "factory" : "fluent-starter", null, true, lineOf(inv));
                    if (!wrappersHolder) {
                        String rf = receiverFieldName(recv);
                        made.factoryReceiver = (rf != null) ? rf : receiverKeywordOrSelf(recv);
                        made.factoryReceiverType = (rf != null) ? fields.get(rf) : ownSimple;
                    }
                    all.add(made);
                    value.put(inv, made);
                    return made;
                }

                W fromNew(NewClassTree nc, String declKind, List<String> declArgs) {
                    String simple = typeSimpleName(nc.getIdentifier());
                    String kind = wrapperKindOf(simple);
                    if (kind == null) return null;
                    List<String> args = typeArgSimples(nc.getIdentifier());
                    String entity = !args.isEmpty() ? args.get(0)
                            : (declArgs != null && !declArgs.isEmpty() ? declArgs.get(0) : null);
                    W w = new W(null, kind, entity, "new", null, true, lineOf(nc));
                    all.add(w);
                    value.put(nc, w);
                    return w;
                }

                /** The wrapper an expression evaluates to, or null. */
                W wrapperOfExpr(ExpressionTree e) {
                    ExpressionTree x = unwrap(e);
                    if (x == null) return null;
                    W known = value.get(x);
                    if (known != null) return known;
                    if (x instanceof IdentifierTree) return vars.get(((IdentifierTree) x).getName().toString());
                    if (x instanceof MemberSelectTree) {
                        MemberSelectTree ms = (MemberSelectTree) x;
                        if (ms.getExpression() instanceof IdentifierTree
                                && "this".equals(((IdentifierTree) ms.getExpression()).getName().toString())) {
                            return vars.get(ms.getIdentifier().toString());
                        }
                        return null;
                    }
                    if (x instanceof NewClassTree) return fromNew((NewClassTree) x, null, null);
                    if (x instanceof MethodInvocationTree) return resolveChain((MethodInvocationTree) x);
                    return null;
                }

                void addSink(W w, ExpressionTree recv, String method, int line) {
                    String rf = receiverFieldName(recv);
                    if (rf != null && fields.containsKey(rf)) {
                        w.sinks.add(sinkRec("field", rf, fields.get(rf), method, line));
                    } else if (recv == null || receiverKeyword(recv) != null) {
                        w.sinks.add(sinkRec("this", (recv == null) ? null : receiverKeyword(recv), ownSimple, method, line));
                    } else {
                        w.sinks.add(sinkRec("passed-on", rf, null, method, line));
                    }
                }

                void addOp(W w, String name, MethodInvocationTree inv, int line) {
                    Map<String, Object> op = new LinkedHashMap<>();
                    op.put("name", name);
                    // One entry per TOP-LEVEL argument: its string value when the
                    // argument is a string literal, its value when it is a boolean
                    // literal (MP's `eq(boolean condition, …)` overloads put one in
                    // front), and null for anything else. WHICH position names a
                    // column is the bridge's reading, not this scan's.
                    List<Object> args = new ArrayList<>();
                    List<Object> props = new ArrayList<>();
                    for (ExpressionTree a : inv.getArguments()) {
                        ExpressionTree ua = unwrap(a);
                        Object slot = null;
                        if (ua instanceof LiteralTree) {
                            Object v = ((LiteralTree) ua).getValue();
                            if (v instanceof String || v instanceof Boolean) slot = v;
                        }
                        args.add(slot);
                        collectMemberRefs(a, props);
                    }
                    op.put("args", args);
                    op.put("props", props);
                    op.put("line", line);
                    w.ops.add(op);
                }
            }, null);

            for (W w : all) {
                Map<String, Object> rec = new LinkedHashMap<>();
                rec.put("kind", "mpWrapper");
                rec.put("from", from);
                rec.put("var", w.var);
                rec.put("wrapperKind", w.kind);
                rec.put("entityTypeSimple", w.entitySimple);
                rec.put("origin", w.origin);
                rec.put("builtBy", w.initFrom);
                rec.put("opsComplete", w.opsComplete);
                rec.put("factoryReceiver", w.factoryReceiver);
                rec.put("factoryReceiverType", w.factoryReceiverType);
                rec.put("ops", w.ops);
                rec.put("sinks", w.sinks);
                rec.put("line", w.line);
                rec.put("file", rel);
                sink.mpWrappers++;
                sink.add("7mpwrapper" + SEP + from + SEP + pad(w.line) + SEP + (w.var == null ? "" : w.var)
                        + SEP + Integer.toString(sink.mpWrappers), rec);
            }
        }

        Map<String, Object> sinkRec(String kind, String receiver, String receiverType, String method, int line) {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("kind", kind);
            s.put("receiver", receiver);
            s.put("receiverTypeSimple", receiverType);
            s.put("method", method);
            s.put("line", line);
            return s;
        }

        /** `this`/`super` as written, else the receiver's own simple spelling. */
        static String receiverKeywordOrSelf(ExpressionTree e) {
            String k = receiverKeyword(e);
            return (k != null) ? k : null;
        }

        /**
         * `"this"` / `"super"` when the receiver is exactly that keyword, else null.
         * `this.field.m()` is NOT one of these — its receiver is the field.
         */
        static String receiverKeyword(ExpressionTree recvExpr) {
            if (!(recvExpr instanceof IdentifierTree)) return null;
            String n = ((IdentifierTree) recvExpr).getName().toString();
            return ("this".equals(n) || "super".equals(n)) ? n : null;
        }

        /**
         * The FIELD name a receiver expression denotes, for `x.m()` and `this.x.m()`.
         * Null for anything else (a qualified type, a chained call, `super`).
         */
        static String receiverFieldName(ExpressionTree recvExpr) {
            if (recvExpr instanceof IdentifierTree) {
                String n = ((IdentifierTree) recvExpr).getName().toString();
                return ("this".equals(n) || "super".equals(n)) ? null : n;
            }
            if (recvExpr instanceof MemberSelectTree) {
                MemberSelectTree inner = (MemberSelectTree) recvExpr;
                ExpressionTree base = inner.getExpression();
                if (base instanceof IdentifierTree
                        && "this".equals(((IdentifierTree) base).getName().toString())) {
                    return inner.getIdentifier().toString();
                }
            }
            return null;
        }
    }


    /**
     * One condition wrapper as the scan saw it being built. MUTABLE while the
     * method body is walked, then rendered into an `mpWrapper` record.
     */
    static final class W {
        String var;                 // the local/parameter it was bound to, or null
        String kind;                // wrapperKind, from the type that was written
        String entitySimple;        // the declared type argument, or null
        final String origin;        // how it came into existence, as written
        final String initFrom;      // the call that built it, when this lane cannot see through
        final boolean opsComplete;  // false when ops were added outside this method
        final int line;
        String factoryReceiver;     // for `x.lambdaQuery()`: the receiver, as written
        String factoryReceiverType; //  …and its declared type's simple name
        final List<Object> ops = new ArrayList<>();
        final List<Object> sinks = new ArrayList<>();
        W(String var, String kind, String entitySimple, String origin, String initFrom, boolean opsComplete, int line) {
            this.var = var; this.kind = kind; this.entitySimple = entitySimple;
            this.origin = origin; this.initFrom = initFrom; this.opsComplete = opsComplete; this.line = line;
        }
    }

    /**
     * The calls that END a fluent chain wrapper (`…lambdaQuery().eq(…).list()`):
     * their value is the query RESULT, not the wrapper, so the chain stops there
     * and the call becomes the wrapper's sink.
     */
    static final java.util.Set<String> MP_CHAIN_TERMINALS = new java.util.HashSet<>(Arrays.asList(
        "list", "one", "oneOpt", "count", "page", "exists", "remove", "update"));

    /**
     * THE MYBATIS SESSION METHODS THAT TAKE A STATEMENT ID (javafacts/11).
     *
     * `selectList("CmmnCodeManageDAO.selectCmmnCodeList", vo)` is how every
     * eGovFrame DAO runs SQL: no mapper INTERFACE, no annotation, just the
     * statement's runtime key as a string. 1,288 call sites in
     * egovframe-common-components alone, and none of them bound to anything
     * before this. The names are `SqlSession`'s own API plus the two
     * `EgovAbstractMapper` adds on top of it.
     *
     * The name alone decides NOTHING: a service's own `insert(vo)` has this
     * name too. What this list does is say which call sites are worth reading a
     * first argument off; whether the RECEIVER is a MyBatis session at all is
     * decided in src/adapters/java/persistence.mjs, which holds the type records
     * for the whole tree (I-1/I-6).
     */
    static final java.util.Set<String> STATEMENT_METHODS = new java.util.HashSet<>(Arrays.asList(
        "selectList", "selectOne", "selectMap", "select", "selectCursor",
        "list", "selectByPk", "insert", "update", "delete",
        // iBATIS 2's own three (RM56). `SqlMapClient` and the Spring template
        // over it spell the same journey `queryFor…`, and eGovFrame's iBATIS
        // base class puts `list`/`insert`/`update`/`delete` on top of them,
        // which the ten names above already cover.
        "queryForList", "queryForObject", "queryForMap"));

    /**
     * The shape of a MyBatis statement id: a namespace and an id, dotted. It is
     * the whole test a literal has to pass — anything else in that position is
     * a piece of SQL, a table name, a message key, and reading it as a
     * statement id would put a statement in the graph nobody declared.
     */
    static final java.util.regex.Pattern STATEMENT_ID_RE = java.util.regex.Pattern.compile(
        "^[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)+$");

    /**
     * The shape of an iBATIS statement id with no namespace on it (RM56).
     * `list("selectUserVOList", vo)` is the whole runtime key when
     * `useStatementNamespaces` is off, which is iBATIS' default and what every
     * eGovFrame DAO written before MyBatis 3 relies on.
     *
     * A BARE WORD IS A WEAK WITNESS, and this worker treats it as one: the id
     * goes out under its OWN field, `stmtIdBare`, beside the `stmtArg` the
     * census already reads, and the bridge binds it only when exactly one
     * statement in the pack carries that id. A word that names no statement
     * changes nothing at all.
     */
    static final java.util.regex.Pattern BARE_STATEMENT_ID_RE = java.util.regex.Pattern.compile(
        "^[A-Za-z_$][A-Za-z0-9_$]*$");

    /**
     * The annotations that give a Spring bean a NAME, on a class and on a field.
     * `@Resource(name = "egovCmmUseService")` is 909 fields in
     * egovframe-common-components; the field's TYPE is the interface, so the
     * name is the only thing at the call site that says which implementor runs.
     */
    static final java.util.Set<String> BEAN_NAME_TYPE_ANNOTATIONS = new java.util.HashSet<>(Arrays.asList(
        "Service", "Repository", "Component", "Controller", "RestController", "Named"));

    /** Strip parentheses and casts: they change nothing about which object this is. */
    /**
     * The receiver of every method call in one file, read from what the file
     * writes and nothing else (emitInvocations says what it records). Names
     * are scoped: a lambda's and a method's own names over the enclosing
     * classes' fields, innermost first. A name one scope declares twice with
     * two types is `?`, not either of them.
     */
    abstract static class InvocationScanner extends TreeScanner<Void, Void> {
        static final String UNKNOWN = "?";
        final String pkg;
        final java.util.ArrayDeque<Map<String, String>> scopes = new java.util.ArrayDeque<>();
        /** The enclosing classes, innermost first: a named one's fqn, or null for an anonymous one. */
        final java.util.ArrayDeque<String> classes = new java.util.ArrayDeque<>();

        InvocationScanner(String pkg) { this.pkg = pkg; }

        abstract void found(String name, String receiver, Tree sel);

        @Override public Void visitClass(ClassTree ct, Void p) {
            String simple = ct.getSimpleName().toString();
            String outer = classes.isEmpty() ? null : classes.peek();
            String fqn = simple.isEmpty() ? null
                    : (classes.isEmpty() ? (pkg.isEmpty() ? simple : pkg + "." + simple)
                    : (outer == null ? null : outer + "." + simple));
            Map<String, String> fields = new FieldScope();
            for (Tree member : ct.getMembers()) {
                if (member instanceof VariableTree) declare(fields, (VariableTree) member);
            }
            classes.push(fqn == null ? "" : fqn);
            scopes.push(fields);
            try { return super.visitClass(ct, p); } finally { scopes.pop(); classes.pop(); }
        }

        @Override public Void visitMethod(MethodTree m, Void p) {
            Map<String, String> own = new LinkedHashMap<>();
            for (VariableTree v : m.getParameters()) declare(own, v);
            if (m.getBody() != null) collectLocals(m.getBody(), own);
            scopes.push(own);
            try { return super.visitMethod(m, p); } finally { scopes.pop(); }
        }

        @Override public Void visitLambdaExpression(com.sun.source.tree.LambdaExpressionTree le, Void p) {
            Map<String, String> own = new LinkedHashMap<>();
            for (VariableTree v : le.getParameters()) declare(own, v);
            collectLocals(le.getBody(), own);
            scopes.push(own);
            try { return super.visitLambdaExpression(le, p); } finally { scopes.pop(); }
        }

        @Override public Void visitMethodInvocation(MethodInvocationTree inv, Void p) {
            Tree sel = inv.getMethodSelect();
            String name = null;
            String receiver = UNKNOWN;
            if (sel instanceof MemberSelectTree) {
                MemberSelectTree ms = (MemberSelectTree) sel;
                name = ms.getIdentifier().toString();
                receiver = receiverOf(ms.getExpression());
            } else if (sel instanceof IdentifierTree) {
                name = ((IdentifierTree) sel).getName().toString();
                receiver = self();
            }
            // `this(...)` and `super(...)` call a constructor, not a method.
            if (name != null && !"this".equals(name) && !"super".equals(name)) found(name, receiver, sel);
            return super.visitMethodInvocation(inv, p);
        }

        /** The enclosing named class, as `this:<fqn>`; `?` inside an anonymous class. */
        String self() {
            String c = classes.isEmpty() ? "" : classes.peek();
            return c.isEmpty() ? UNKNOWN : "this:" + c;
        }

        /** What a receiver expression is declared as, as far as this file writes it. */
        String receiverOf(ExpressionTree expr) {
            ExpressionTree e = expr;
            if (e instanceof com.sun.source.tree.ParenthesizedTree) e = ((com.sun.source.tree.ParenthesizedTree) e).getExpression();
            if (e instanceof com.sun.source.tree.TypeCastTree) return written(((com.sun.source.tree.TypeCastTree) e).getType());
            if (e instanceof NewClassTree) {
                NewClassTree nc = (NewClassTree) e;
                return nc.getClassBody() != null ? UNKNOWN : written(nc.getIdentifier());
            }
            if (e instanceof IdentifierTree) {
                String n = ((IdentifierTree) e).getName().toString();
                if ("this".equals(n) || "super".equals(n)) return self();
                for (Map<String, String> scope : scopes) {
                    String t = scope.get(n);
                    if (t != null) return t;
                }
                return inherited(n);
            }
            if (e instanceof MemberSelectTree) {
                MemberSelectTree ms = (MemberSelectTree) e;
                ExpressionTree base = ms.getExpression();
                if (base instanceof IdentifierTree && "this".equals(((IdentifierTree) base).getName().toString())) {
                    String f = ms.getIdentifier().toString();
                    Map<String, String> fields = classFields();
                    String t = fields == null ? null : fields.get(f);
                    return t != null ? t : inherited(f);
                }
            }
            return UNKNOWN;
        }

        /**
         * A name this file binds nowhere, inside a named class: perhaps a field a
         * superclass declares (javafacts/21), as `field:<class>#<name>`. Whether
         * one does is read across files, from the field records, not here.
         */
        String inherited(String name) {
            String c = classes.isEmpty() ? "" : classes.peek();
            return c.isEmpty() ? UNKNOWN : "field:" + c + "#" + name;
        }

        /** A class's own fields: the one kind of scope `this.x` reads. */
        static final class FieldScope extends LinkedHashMap<String, String> {}

        /** The innermost enclosing class's fields. */
        Map<String, String> classFields() {
            for (Map<String, String> scope : scopes) if (scope instanceof FieldScope) return scope;
            return null;
        }

        static String written(Tree type) {
            if (type == null || type instanceof ArrayTypeTree) return UNKNOWN;
            String w = typeWrittenName(type);
            return (w == null || "var".equals(w)) ? UNKNOWN : w;
        }

        /**
         * Record one declaration: its written type, or `?` when it has none or a
         * second one disagrees. A `var` takes the type its initializer's `new`
         * writes (javafacts/21), the one thing that states it.
         */
        static void declare(Map<String, String> scope, VariableTree v) {
            String name = v.getName().toString();
            String t = written(v.getType());
            if (UNKNOWN.equals(t) && (v.getType() == null || "var".equals(typeWrittenName(v.getType())))
                    && v.getInitializer() instanceof NewClassTree && ((NewClassTree) v.getInitializer()).getClassBody() == null) {
                t = written(((NewClassTree) v.getInitializer()).getIdentifier());
            }
            String prev = scope.get(name);
            scope.put(name, (prev == null || prev.equals(t)) ? t : UNKNOWN);
        }

        /** Every local a body declares, outside the classes and lambdas inside it (those are scopes of their own). */
        static void collectLocals(Tree body, final Map<String, String> into) {
            if (body == null) return;
            body.accept(new TreeScanner<Void, Void>() {
                @Override public Void visitVariable(VariableTree v, Void p) { declare(into, v); return super.visitVariable(v, p); }
                @Override public Void visitClass(ClassTree ct, Void p) { return null; }
                @Override public Void visitLambdaExpression(com.sun.source.tree.LambdaExpressionTree le, Void p) { return null; }
            }, null);
        }
    }

    static ExpressionTree unwrap(ExpressionTree e) {
        ExpressionTree cur = e;
        for (int i = 0; i < 8 && cur != null; i++) {
            if (cur instanceof com.sun.source.tree.ParenthesizedTree) {
                cur = ((com.sun.source.tree.ParenthesizedTree) cur).getExpression();
            } else if (cur instanceof com.sun.source.tree.TypeCastTree) {
                cur = ((com.sun.source.tree.TypeCastTree) cur).getExpression();
            } else {
                return cur;
            }
        }
        return cur;
    }

    /**
     * Every METHOD REFERENCE in an expression, as `{owner, method, property}`.
     * `SysUserDepart::getDepId` is the only way a lambda wrapper names a column,
     * and the JavaBeans property behind the getter is what the bridge resolves —
     * so both the getter as written and the property it names are recorded.
     */
    static void collectMemberRefs(Tree t, final List<Object> out) {
        if (t == null) return;
        t.accept(new TreeScanner<Void, Void>() {
            @Override public Void visitMemberReference(MemberReferenceTree mr, Void p) {
                String owner = typeSimpleName(mr.getQualifierExpression());
                String method = mr.getName().toString();
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("owner", owner);
                m.put("method", method);
                m.put("property", propertyNameOf(method));
                out.add(m);
                return super.visitMemberReference(mr, p);
            }
        }, null);
    }

    /** The name of the method a call invokes, qualified as written (`X.y`), or null. */
    static String calleeName(MethodInvocationTree inv) {
        Tree sel = inv.getMethodSelect();
        if (sel instanceof IdentifierTree) return ((IdentifierTree) sel).getName().toString();
        if (sel instanceof MemberSelectTree) {
            MemberSelectTree ms = (MemberSelectTree) sel;
            String recv = null;
            ExpressionTree e = ms.getExpression();
            if (e instanceof IdentifierTree) recv = ((IdentifierTree) e).getName().toString();
            else if (e instanceof MemberSelectTree) recv = ((MemberSelectTree) e).getIdentifier().toString();
            return (recv == null) ? ms.getIdentifier().toString() : recv + "." + ms.getIdentifier().toString();
        }
        return null;
    }

    /** A line number, zero-padded, so a SORT KEY orders by line and not by digit. */
    static String pad(int line) {
        String s = Integer.toString(Math.max(line, 0));
        StringBuilder sb = new StringBuilder();
        for (int i = s.length(); i < 8; i++) sb.append('0');
        return sb.append(s).toString();
    }

    // ---- mapping detection ----------------------------------------------------
    static final class Mapping {
        final String httpMethod;
        final PathRead path;
        // The names a `method` attribute wrote that are no HTTP method (javafacts/22):
        // this mapping answers some method this worker did not read, on the ANY route.
        final List<String> methodUnread;
        // The request conditions (javafacts/22) that narrow the mapping to some requests.
        final List<String> conditions;
        Mapping(String httpMethod, PathRead path, List<String> methodUnread, List<String> conditions) {
            this.httpMethod = httpMethod; this.path = path; this.methodUnread = methodUnread; this.conditions = conditions;
        }
    }

    /** The HTTP methods Spring's RequestMethod names; a `method` element that is none of them is not read as one. */
    static final java.util.Set<String> REQUEST_METHODS = new java.util.HashSet<>(java.util.Arrays.asList(
            "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"));
    /** The attributes that narrow a mapping to the requests that carry them: one route, split by them. */
    static final String[] REQUEST_CONDITIONS = { "params", "headers", "consumes", "produces" };

    /**
     * The methods a mapping annotation names (javafacts/22). `read` is what the
     * source states; `unread` is each element that is no HTTP method, as written
     * (`VERBS`, a constant this file cannot read). Both empty is a mapping that
     * names no method, which Spring serves for every one.
     */
    static final class Verbs {
        final java.util.LinkedHashSet<String> read = new java.util.LinkedHashSet<>();
        final List<String> unread = new ArrayList<>();
        /** Spring's rule (RequestMethodsRequestCondition.combine): the class's methods and the method's, as one union. */
        Verbs with(Verbs classLevel) {
            if (classLevel == null) return this;
            Verbs out = new Verbs();
            out.read.addAll(classLevel.read);
            out.read.addAll(read);
            out.unread.addAll(classLevel.unread);
            for (String u : unread) if (!out.unread.contains(u)) out.unread.add(u);
            return out;
        }
    }

    /** The methods a mapping annotation of this simple name states; null when it is no mapping annotation. */
    static Verbs verbsOfMapping(String simple, AnnotationTree a) {
        Verbs v = new Verbs();
        switch (simple == null ? "" : simple) {
            case "GetMapping":    v.read.add("GET"); return v;
            case "PostMapping":   v.read.add("POST"); return v;
            case "PutMapping":    v.read.add("PUT"); return v;
            case "DeleteMapping": v.read.add("DELETE"); return v;
            case "PatchMapping":  v.read.add("PATCH"); return v;
            case "RequestMapping": return requestVerbs(a);
            default: return null;
        }
    }

    /**
     * The methods a @RequestMapping's `method` attribute names, one or an array,
     * in the order written. `RequestMethod.POST` and a static-imported `POST` are
     * POST; any other name is no HTTP method and is kept as written (J-10).
     */
    static Verbs requestVerbs(AnnotationTree a) {
        Verbs v = new Verbs();
        ExpressionTree e = unwrap(annAttr(a, "method"));
        List<ExpressionTree> elems = new ArrayList<>();
        if (e instanceof NewArrayTree) {
            if (((NewArrayTree) e).getInitializers() != null) elems.addAll(((NewArrayTree) e).getInitializers());
        } else if (e != null) {
            elems.add(e);
        }
        for (ExpressionTree it : elems) {
            String name = firstMemberName(unwrap(it));
            if (name != null && REQUEST_METHODS.contains(name)) v.read.add(name);
            else if (!v.unread.contains(String.valueOf(it))) v.unread.add(String.valueOf(it));
        }
        return v;
    }

    /** The request conditions a mapping annotation writes and does not leave empty, in a fixed order. */
    static List<String> conditionsOf(AnnotationTree a) {
        List<String> out = new ArrayList<>();
        for (String c : REQUEST_CONDITIONS) {
            ExpressionTree e = unwrap(annAttr(a, c));
            if (e == null) continue;
            if (e instanceof NewArrayTree && (((NewArrayTree) e).getInitializers() == null || ((NewArrayTree) e).getInitializers().isEmpty())) continue;
            if (e instanceof LiteralTree && "".equals(((LiteralTree) e).getValue())) continue;
            out.add(c);
        }
        return out;
    }

    /**
     * Every route a method's mapping annotation declares (javafacts/20): one per
     * method it names and per path it names. `method = {PUT, POST}` serves the
     * handler for both, and `value = {"/a", "/b"}` at both, so reading only the
     * first of either list dropped routes Spring serves. The class-level
     * mapping's methods join the method's own (javafacts/22), and a path is read
     * against the class's own constants. Null when the method carries no
     * mapping annotation.
     */
    static List<Mapping> methodMappings(MethodTree m, Map<String, String> own, String ownSimple, Verbs classVerbs) {
        for (AnnotationTree a : m.getModifiers().getAnnotations()) {
            Verbs verbs = verbsOfMapping(typeSimpleName(a.getAnnotationType()), a);
            if (verbs == null) continue; // not a mapping annotation
            return mappingsOf(verbs.with(classVerbs), annPathReads(a, own, ownSimple), conditionsOf(a));
        }
        return null;
    }

    /**
     * The routes one mapping serves: each method it states at each path, and,
     * when it names a method this worker could not read, the ANY route with the
     * names it could not read on it. No method at all is ANY, as Spring serves it.
     */
    static List<Mapping> mappingsOf(Verbs verbs, List<PathRead> paths, List<String> conditions) {
        List<Mapping> out = new ArrayList<>();
        List<String> read = new ArrayList<>(verbs.read);
        if (read.isEmpty() && verbs.unread.isEmpty()) read.add("ANY");
        for (String verb : read) for (PathRead p : paths) out.add(new Mapping(verb, p, null, conditions));
        if (!verbs.unread.isEmpty()) for (PathRead p : paths) out.add(new Mapping("ANY", p, verbs.unread, conditions));
        return out;
    }

    /**
     * ONE PATH A MAPPING NAMES (javafacts/22). `text` is the path when this file
     * states it: a literal, a `static final String` of the class itself, or a
     * concatenation of those. Otherwise `parts` is what the path is written in,
     * for the bridge to read against the rest of the tree (a constant of
     * another type is another file's fact): `{lit}` a string this file states,
     * `{ref}` a constant of another type or a name this file does not declare,
     * `{unread}` anything else, each as written. Both null: no path at all.
     */
    static final class PathRead {
        final String text;
        final List<Object> parts;
        final String written;
        PathRead(String text, List<Object> parts, String written) { this.text = text; this.parts = parts; this.written = written; }
        boolean known() { return parts == null; }
        /** The parts this path contributes to a longer one. */
        List<Object> asParts() {
            if (parts != null) return parts;
            List<Object> out = new ArrayList<>();
            if (text != null) out.add(pathPart("lit", text));
            return out;
        }
    }

    static Map<String, Object> pathPart(String kind, String value) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put(kind, value);
        return p;
    }

    /** The paths an annotation's value/path attribute names, positional or named, one or an array, each once. */
    static List<PathRead> annPathReads(AnnotationTree a, Map<String, String> own, String ownSimple) {
        ExpressionTree e = annAttr(a, "value");
        if (e == null) e = annAttr(a, "path");
        e = unwrap(e);
        List<ExpressionTree> elems = new ArrayList<>();
        if (e instanceof NewArrayTree) {
            if (((NewArrayTree) e).getInitializers() != null) elems.addAll(((NewArrayTree) e).getInitializers());
        } else if (e != null) {
            elems.add(e);
        }
        List<PathRead> out = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (ExpressionTree it : elems) {
            PathRead r = readPath(it, own, ownSimple);
            if (seen.add(r.known() ? "t" + r.text : "p" + r.parts)) out.add(r);
        }
        if (out.isEmpty()) out.add(new PathRead(null, null, null));
        return out;
    }

    /** One path expression, read as far as this file allows. */
    static PathRead readPath(ExpressionTree e, Map<String, String> own, String ownSimple) {
        List<Object> parts = new ArrayList<>();
        addPathParts(e, own, ownSimple, parts, 0);
        StringBuilder text = new StringBuilder();
        for (Object p : parts) {
            @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) p;
            if (!m.containsKey("lit")) return new PathRead(null, mergeLits(parts), String.valueOf(unwrap(e)));
            text.append(m.get("lit"));
        }
        return new PathRead(text.toString(), null, null);
    }

    /** The parts a string expression is written in, a literal or an own constant already read. */
    static void addPathParts(ExpressionTree raw, Map<String, String> own, String ownSimple, List<Object> out, int depth) {
        ExpressionTree e = unwrap(raw);
        if (e instanceof LiteralTree && ((LiteralTree) e).getValue() instanceof String) {
            out.add(pathPart("lit", (String) ((LiteralTree) e).getValue()));
        } else if (depth < 16 && e instanceof BinaryTree && e.getKind() == Tree.Kind.PLUS) {
            addPathParts(((BinaryTree) e).getLeftOperand(), own, ownSimple, out, depth + 1);
            addPathParts(((BinaryTree) e).getRightOperand(), own, ownSimple, out, depth + 1);
        } else if (e instanceof IdentifierTree) {
            String n = ((IdentifierTree) e).getName().toString();
            out.add(own != null && own.containsKey(n) ? pathPart("lit", own.get(n)) : pathPart("ref", n));
        } else if (e instanceof MemberSelectTree) {
            MemberSelectTree ms = (MemberSelectTree) e;
            String n = ms.getIdentifier().toString();
            boolean mine = ownSimple != null && own != null && ownSimple.equals(String.valueOf(ms.getExpression())) && own.containsKey(n);
            out.add(mine ? pathPart("lit", own.get(n)) : pathPart("ref", String.valueOf(e)));
        } else {
            out.add(pathPart("unread", String.valueOf(e)));
        }
    }

    /** Adjacent literals as one, so the parts say only what is not known. */
    static List<Object> mergeLits(List<Object> parts) {
        List<Object> out = new ArrayList<>();
        for (Object p : parts) {
            @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) p;
            Object last = out.isEmpty() ? null : out.get(out.size() - 1);
            @SuppressWarnings("unchecked") Map<String, Object> lm = (Map<String, Object>) last;
            if (lm != null && lm.containsKey("lit") && m.containsKey("lit")) {
                out.set(out.size() - 1, pathPart("lit", String.valueOf(lm.get("lit")) + m.get("lit")));
            } else {
                out.add(m);
            }
        }
        return out;
    }

    /** A class path and a method path, joined: text when both are known, else the parts of both. */
    static PathRead joinReads(PathRead base, PathRead own) {
        if (base.known() && own.known()) return new PathRead(joinPath(base.text, own.text), null, null);
        List<Object> parts = new ArrayList<>(base.asParts());
        parts.add(pathPart("lit", "/"));
        parts.addAll(own.asParts());
        String written = base.written == null ? own.written : (own.written == null ? base.written : base.written + " and " + own.written);
        return new PathRead(null, mergeLits(parts), written);
    }


    /** One path as a record states it: its text, null for none, or its parts and what was written. */
    static Object readJson(PathRead p) {
        if (p.known()) return p.text;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("parts", p.parts);
        out.put("written", p.written);
        return out;
    }

    /** Each path an attribute value names, as `readJson` states it; null when the attribute is not written. */
    static List<Object> readsJson(ExpressionTree e, Map<String, String> own, String ownSimple) {
        if (e == null) return null;
        ExpressionTree u = unwrap(e);
        List<ExpressionTree> elems = new ArrayList<>();
        if (u instanceof NewArrayTree) {
            if (((NewArrayTree) u).getInitializers() != null) elems.addAll(((NewArrayTree) u).getInitializers());
        } else {
            elems.add(u);
        }
        List<Object> out = new ArrayList<>();
        for (ExpressionTree it : elems) out.add(readJson(readPath(it, own, ownSimple)));
        return out;
    }

    /** The methods a mapping names, as a record states them. */
    static Map<String, Object> verbsJson(Verbs v) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("read", new ArrayList<>(v.read));
        out.put("unread", v.unread);
        return out;
    }

    /**
     * The attributes of an annotation type that are @AliasFor the meta mapping
     * annotation's own (javafacts/22), by name: `String[] value()` with
     * `@AliasFor(annotation = RequestMapping.class)` is RequestMapping's value,
     * and `attribute = "path"` names another. An alias inside the type itself
     * (no `annotation`) is not the meta annotation's.
     */
    static Map<String, Object> aliasesOf(ClassTree ct, String meta) {
        Map<String, Object> out = new java.util.TreeMap<>();
        for (Tree member : ct.getMembers()) {
            if (!(member instanceof MethodTree)) continue;
            MethodTree m = (MethodTree) member;
            AnnotationTree alias = annNamed(annotationsOf(m.getModifiers().getAnnotations()), "AliasFor");
            if (alias == null) continue;
            ExpressionTree target = unwrap(namedAttr(alias, "annotation"));
            if (target == null) continue;
            String t = String.valueOf(target);
            if (t.endsWith(".class")) t = t.substring(0, t.length() - ".class".length());
            if (!t.equals(meta) && !t.endsWith("." + meta)) continue;
            String attr = firstString(namedAttr(alias, "attribute"));
            if (attr == null) attr = firstString(annAttr(alias, "value"));
            out.put(m.getName().toString(), attr != null ? attr : m.getName().toString());
        }
        return out;
    }

    /** A NAMED attribute of an annotation, never the positional one. */
    static ExpressionTree namedAttr(AnnotationTree a, String name) {
        for (ExpressionTree arg : a.getArguments()) {
            if (!(arg instanceof AssignmentTree)) continue;
            AssignmentTree as = (AssignmentTree) arg;
            if (as.getVariable() instanceof IdentifierTree && ((IdentifierTree) as.getVariable()).getName().toString().equals(name)) return as.getExpression();
        }
        return null;
    }

    /**
     * The `static final String` constants a type declares with a value this file
     * states (javafacts/22): a literal, or a concatenation of literals and
     * constants of the type itself. An interface's fields are such constants
     * with no modifier written. A mapping path elsewhere may name one.
     */
    static Map<String, String> stringConstantsOf(ClassTree ct) {
        boolean iface = ct.getKind() == Tree.Kind.INTERFACE || ct.getKind() == Tree.Kind.ANNOTATION_TYPE;
        Map<String, ExpressionTree> pending = new LinkedHashMap<>();
        for (Tree member : ct.getMembers()) {
            if (!(member instanceof VariableTree)) continue;
            VariableTree v = (VariableTree) member;
            java.util.Set<Modifier> flags = v.getModifiers().getFlags();
            if (!iface && (!flags.contains(Modifier.STATIC) || !flags.contains(Modifier.FINAL))) continue;
            if (!"String".equals(typeSimpleName(v.getType())) || v.getInitializer() == null) continue;
            pending.put(v.getName().toString(), v.getInitializer());
        }
        Map<String, String> out = new java.util.TreeMap<>();
        // A constant may be built from another the type declares later: read
        // until a pass reads nothing new.
        for (int pass = 0; pass < 8 && !pending.isEmpty(); pass++) {
            boolean grew = false;
            for (java.util.Iterator<Map.Entry<String, ExpressionTree>> it = pending.entrySet().iterator(); it.hasNext();) {
                Map.Entry<String, ExpressionTree> c = it.next();
                PathRead r = readPath(c.getValue(), out, ct.getSimpleName().toString());
                if (!r.known() || r.text.length() > ROUTE_STRING_LIMIT) continue;
                out.put(c.getKey(), r.text);
                it.remove();
                grew = true;
            }
            if (!grew) break;
        }
        return out;
    }

    /** Annotations that make a type a DECLARATIVE HTTP CLIENT rather than a route holder. */
    static final String[] CLIENT_ANNOTATIONS = { "FeignClient", "HttpExchange" };

    /**
     * The client annotation a type carries, as evidence: which one, the service it
     * names, its base url and its path prefix — each as WRITTEN. `value` is very
     * often a constant reference (`ServiceNameConstants.SERVICE_SYSTEM`), which
     * this parse-only worker cannot resolve to a string; the reference itself is
     * recorded rather than dropped, and `serviceLiteral` says which it is, so a
     * reader is never shown a constant NAME as if it were the service name.
     */
    static Map<String, Object> clientAnnotationOf(List<AnnotationTree> anns) {
        for (String simple : CLIENT_ANNOTATIONS) {
            AnnotationTree a = annNamed(anns, simple);
            if (a == null) continue;
            ExpressionTree svc = annAttr(a, "name");
            if (svc == null) svc = annAttr(a, "value");
            String svcLiteral = firstString(svc);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("kind", simple);
            out.put("service", (svc == null) ? null : (svcLiteral != null ? svcLiteral : svc.toString()));
            out.put("serviceLiteral", svcLiteral != null);
            out.put("url", firstString(annAttr(a, "url")));
            out.put("path", clientPathAttr(a, simple));
            return out;
        }
        return null;
    }

    /** The path prefix a client annotation declares (@FeignClient(path=…), @HttpExchange("…")). */
    static String clientPathAttr(AnnotationTree a, String simple) {
        if ("HttpExchange".equals(simple)) {
            String v = firstString(annAttr(a, "value"));
            return (v != null) ? v : firstString(annAttr(a, "url"));
        }
        return firstString(annAttr(a, "path"));
    }

    /** The path prefix of whichever client annotation this type carries, or null. */
    static String clientPathOf(List<AnnotationTree> anns) {
        Map<String, Object> c = clientAnnotationOf(anns);
        return (c == null) ? null : (String) c.get("path");
    }

    // ---- imperative HTTP clients (javafacts/8) --------------------------------

    /** Type simple names that make a receiver one of the three standard clients. */
    static final String[][] HTTP_CLIENT_TYPES = {
        {"WebClient", "webclient"},
        {"RestClient", "restclient"},
        {"RestTemplate", "resttemplate"},
        {"RestOperations", "resttemplate"},
    };

    /**
     * The client kind a WRITTEN type name denotes, or null.
     *
     * Matched SEGMENT BY SEGMENT, so `WebClient.Builder` and the fully qualified
     * spelling both name a WebClient, and a package called `restclient` names
     * nothing. A substring test would do neither.
     */
    static String httpClientKindOf(String written) {
        if (written == null) return null;
        for (String seg : written.split("\\.")) {
            for (String[] pair : HTTP_CLIENT_TYPES) if (pair[0].equals(seg)) return pair[1];
        }
        return null;
    }

    /** The calls that SEND a fluent request: what ends a WebClient/RestClient chain. */
    static final java.util.Set<String> FLUENT_TERMINALS = new java.util.HashSet<>(Arrays.asList(
        "retrieve", "exchange", "exchangeToMono", "exchangeToFlux"));

    /** The step of a fluent chain that carries the url. */
    static final java.util.Set<String> FLUENT_URI_METHODS = new java.util.HashSet<>(Arrays.asList("uri", "url"));

    /** How many steps of one fluent chain are read before the walk gives up. */
    static final int FLUENT_CHAIN_LIMIT = 32;

    /**
     * The return types that mark a method as one that BUILDS ROUTES
     * (javafacts/17), by simple name: Spring's functional endpoints, WebFlux's
     * and WebMvc's alike, are a `RouterFunction`. Mirrored in
     * src/core/rules/kinds/java_route_function.mjs, where a rule may only read a
     * type the worker records; a test holds the two lists equal.
     */
    static final java.util.Set<String> ROUTE_FUNCTION_TYPES = new java.util.HashSet<>(Arrays.asList("RouterFunction"));
    /** How many nodes one method's tree may hold; past it the rest is recorded as cut. */
    static final int ROUTE_TREE_BUDGET = 6000;
    /** How long a string in that tree may be; a longer one (a description) is recorded as cut. */
    static final int ROUTE_STRING_LIMIT = 300;

    /** A fluent verb method and the HTTP method it names. */
    static final String[][] FLUENT_VERBS = {
        {"get", "GET"}, {"post", "POST"}, {"put", "PUT"}, {"delete", "DELETE"},
        {"patch", "PATCH"}, {"head", "HEAD"}, {"options", "OPTIONS"},
    };

    /** The HTTP methods this worker will name. Anything else is not one. */
    static final java.util.Set<String> HTTP_METHOD_NAMES = new java.util.HashSet<>(Arrays.asList(
        "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"));

    /**
     * The HTTP method an ARGUMENT names (`HttpMethod.POST`), or null.
     *
     * The name has to BE an HTTP method. `exchange(url, method, …)` hands the
     * verb in a variable called `method`, and reading that name as the verb
     * would put "method" in the record where a verb belongs — a value from the
     * source that says nothing about which request is sent.
     */
    static String httpMethodArgOf(ExpressionTree e) {
        String name = firstMemberName(e);
        return (name != null && HTTP_METHOD_NAMES.contains(name)) ? name : null;
    }

    /**
     * The HTTP method a chain step names, or null when the step is not a verb.
     *
     * A verb call takes NO arguments (`webClient.get()`), which is what keeps
     * `map.get(k)` out; `method(HttpMethod.X)` names its verb in an argument,
     * and an argument this file cannot read leaves the method unknown rather
     * than assumed.
     */
    static String fluentVerbOf(String name, MethodInvocationTree step) {
        if ("method".equals(name)) {
            return step.getArguments().isEmpty() ? null : httpMethodArgOf(step.getArguments().get(0));
        }
        if (!step.getArguments().isEmpty()) return null;
        for (String[] pair : FLUENT_VERBS) if (pair[0].equals(name)) return pair[1];
        return null;
    }

    /**
     * RestTemplate's request methods and the HTTP method each sends. An EMPTY
     * value means the verb is named by argument 1 (`exchange(url, HttpMethod.X, …)`,
     * `execute(url, HttpMethod.X, …)`) rather than by the method name.
     */
    static final Map<String, String> REST_TEMPLATE_VERBS = restTemplateVerbs();

    static Map<String, String> restTemplateVerbs() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("getForObject", "GET");
        m.put("getForEntity", "GET");
        m.put("postForObject", "POST");
        m.put("postForEntity", "POST");
        m.put("postForLocation", "POST");
        m.put("put", "PUT");
        m.put("delete", "DELETE");
        m.put("patchForObject", "PATCH");
        m.put("headForHeaders", "HEAD");
        m.put("optionsForAllow", "OPTIONS");
        m.put("exchange", "");
        m.put("execute", "");
        return m;
    }

    /** What stands in a url where the code interpolated a value this file cannot read. */
    static final String URL_HOLE = "{*}";

    /** How much of a url expression one record carries, so a record cannot hold a page. */
    static final int URL_TEXT_LIMIT = 200;

    /** A url as this worker could read it: how much of it is literal, and what it says. */
    static final class UrlRead {
        String kind;    // literal | template | concat | unresolved
        String value;   // the url as text, with {*} where a value was interpolated
        String base;    // the leading operand that is not a literal, as written
        String written; // the whole expression, as written
    }

    /**
     * One url argument, reduced no further than this file allows.
     *
     * A `+` chain is flattened and read left to right. A LEADING operand that is
     * not a literal is the BASE — a constant or a call holding `scheme://host/`,
     * which a parse-only, one-file-at-a-time worker cannot resolve — so it is
     * named as written and left out of the path; every later non-literal is a
     * value interpolated INTO the path, so it becomes a `{*}` hole the way the
     * web lane spells one. Nothing literal anywhere means the url is not in this
     * file at all: `unresolved`, with the expression as written and no path.
     */
    static UrlRead readUrl(ExpressionTree e) {
        UrlRead out = new UrlRead();
        out.written = writtenText(e);
        List<ExpressionTree> parts = new ArrayList<>();
        flattenPlus(e, parts);
        StringBuilder sb = new StringBuilder();
        boolean anyLiteral = false;
        boolean anyHole = false;
        String base = null;
        for (int i = 0; i < parts.size(); i++) {
            ExpressionTree part = parts.get(i);
            String lit = null;
            if (part instanceof LiteralTree) {
                Object v = ((LiteralTree) part).getValue();
                if (v instanceof String) lit = (String) v;
            }
            if (lit != null) { sb.append(lit); anyLiteral = true; continue; }
            if (i == 0) { base = writtenText(part); continue; }
            anyHole = true;
            sb.append(URL_HOLE);
        }
        if (!anyLiteral) { out.kind = "unresolved"; return out; }
        out.value = sb.toString();
        out.base = base;
        out.kind = (base != null || anyHole) ? "concat"
                : (out.value.indexOf('{') >= 0 ? "template" : "literal");
        return out;
    }

    /** Flatten a `+` expression into its operands, left to right. */
    static void flattenPlus(ExpressionTree e, List<ExpressionTree> out) {
        ExpressionTree x = unwrap(e);
        if (x instanceof BinaryTree && ((BinaryTree) x).getKind() == Tree.Kind.PLUS) {
            flattenPlus(((BinaryTree) x).getLeftOperand(), out);
            flattenPlus(((BinaryTree) x).getRightOperand(), out);
            return;
        }
        out.add(x);
    }

    /** An expression as the source wrote it, on one line and capped. */
    static String writtenText(Tree t) {
        if (t == null) return null;
        String s = t.toString().replace('\n', ' ').replace('\r', ' ').trim();
        return (s.length() > URL_TEXT_LIMIT) ? s.substring(0, URL_TEXT_LIMIT) : s;
    }

    /**
     * Split `scheme://host/rest` into its host and what follows it. A url with no
     * `://` is all path, and the host comes back null.
     */
    static String[] splitHost(String url) {
        int i = url.indexOf("://");
        if (i < 0) return new String[]{null, url};
        int j = url.indexOf('/', i + 3);
        String host = (j < 0) ? url.substring(i + 3) : url.substring(i + 3, j);
        String rest = (j < 0) ? "" : url.substring(j);
        return new String[]{host, rest};
    }

    /**
     * The type as WRITTEN (`WebClient.Builder`, `java.util.List`), so a nested
     * type is not read as its last segment alone. `typeSimpleName` answers the
     * other question and both are needed.
     */
    static String typeWrittenName(Tree t) {
        if (t == null) return null;
        if (t instanceof IdentifierTree) return ((IdentifierTree) t).getName().toString();
        if (t instanceof MemberSelectTree) {
            MemberSelectTree ms = (MemberSelectTree) t;
            String base = typeWrittenName(ms.getExpression());
            return (base == null) ? ms.getIdentifier().toString() : base + "." + ms.getIdentifier().toString();
        }
        if (t instanceof ParameterizedTypeTree) return typeWrittenName(((ParameterizedTypeTree) t).getType());
        if (t instanceof ArrayTypeTree) return typeWrittenName(((ArrayTypeTree) t).getType());
        return null;
    }

    /** Every method a type declares, as "name/arity"; constructors excluded, order kept. */
    /** An interface's methods declared `default`, as "name/arity", in declaration order, each once; empty for a class. */
    static List<String> defaultMethodsOf(ClassTree ct) {
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        if (ct.getKind() == Tree.Kind.INTERFACE) {
            for (Tree member : ct.getMembers()) {
                if (!(member instanceof MethodTree)) continue;
                MethodTree m = (MethodTree) member;
                if (m.getModifiers().getFlags().contains(Modifier.DEFAULT)) out.add(m.getName() + "/" + m.getParameters().size());
            }
        }
        return new ArrayList<>(out);
    }

    /**
     * An interface's abstract methods, as "name/arity" (javafacts/22): no body,
     * no default, not static, not private, and not one of the public methods
     * every object has (which a lambda does not implement).
     */
    static List<String> abstractMethodsOf(ClassTree ct) {
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        for (Tree member : ct.getMembers()) {
            if (!(member instanceof MethodTree)) continue;
            MethodTree m = (MethodTree) member;
            java.util.Set<Modifier> flags = m.getModifiers().getFlags();
            if (m.getBody() != null || flags.contains(Modifier.DEFAULT) || flags.contains(Modifier.STATIC) || flags.contains(Modifier.PRIVATE)) continue;
            String key = m.getName() + "/" + m.getParameters().size();
            if (key.equals("equals/1") || key.equals("hashCode/0") || key.equals("toString/0")) continue;
            out.add(key);
        }
        return new ArrayList<>(out);
    }

    static List<String> declaredMethodsOf(ClassTree ct) {
        return new ArrayList<>(declaredMethodKeys(ct));
    }

    /** The same list, deduplicated in declaration order — the one place the rule lives. */
    static List<String> declaredMethodKeys(ClassTree ct) {
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        for (Tree member : ct.getMembers()) {
            if (!(member instanceof MethodTree)) continue;
            MethodTree m = (MethodTree) member;
            String n = m.getName().toString();
            if ("<init>".equals(n)) continue; // a constructor is not a callable member here
            out.add(n + "/" + m.getParameters().size());
        }
        return new ArrayList<>(out);
    }

    /** Join two path halves, either of which may be null/empty; null when both are. */
    static String joinPathParts(String a, String b) {
        if (a == null || a.trim().isEmpty()) return b;
        if (b == null || b.trim().isEmpty()) return a;
        return joinPath(a, b);
    }

    /**
     * The paths a class-level mapping puts in front of its methods' routes: each
     * one a `value`/`path` array names (javafacts/20), read against the class's
     * own constants (javafacts/22). A single "no path" when the class names
     * none, so the method's own path stands alone.
     */
    static List<PathRead> classLevelBasePaths(List<AnnotationTree> anns, Map<String, String> own, String ownSimple) {
        for (AnnotationTree a : anns) {
            if (verbsOfMapping(typeSimpleName(a.getAnnotationType()), a) == null) continue;
            List<PathRead> ps = annPathReads(a, own, ownSimple);
            if (ps.get(0).text != null || ps.get(0).parts != null) return ps;
        }
        List<PathRead> none = new ArrayList<>();
        none.add(new PathRead(null, null, null));
        return none;
    }

    /**
     * The methods a class-level @RequestMapping names (javafacts/22), which
     * Spring joins to every method-level mapping of the class. Null when the
     * class names none.
     */
    static Verbs classLevelVerbs(List<AnnotationTree> anns) {
        AnnotationTree a = annNamed(anns, "RequestMapping");
        if (a == null) return null;
        Verbs v = requestVerbs(a);
        return v.read.isEmpty() && v.unread.isEmpty() ? null : v;
    }

    /** The client prefix and the class path, one path in front of every route of the class. */
    static PathRead withClientPath(String client, PathRead classPath) {
        if (classPath.known()) return new PathRead(joinPathParts(client, classPath.text), null, null);
        if (client == null || client.trim().isEmpty()) return classPath;
        return joinReads(new PathRead(client, null, null), classPath);
    }

    // Return the expression for a named attribute, or the positional value for "value".
    static ExpressionTree annAttr(AnnotationTree a, String name) {
        for (ExpressionTree arg : a.getArguments()) {
            if (arg instanceof AssignmentTree) {
                AssignmentTree as = (AssignmentTree) arg;
                if (as.getVariable() instanceof IdentifierTree) {
                    String var = ((IdentifierTree) as.getVariable()).getName().toString();
                    if (var.equals(name)) return as.getExpression();
                }
            } else if ("value".equals(name)) {
                return arg; // single-element (positional) annotation value
            }
        }
        return null;
    }

    // First string literal of an expression that may be a literal or an array.
    static String firstString(ExpressionTree e) {
        if (e == null) return null;
        if (e instanceof LiteralTree) {
            Object v = ((LiteralTree) e).getValue();
            return (v instanceof String) ? (String) v : null;
        }
        if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) {
                for (ExpressionTree it : inits) {
                    String s = firstString(it);
                    if (s != null) return s;
                }
            }
        }
        return null;
    }

    // First member/identifier name (e.g. RequestMethod.POST -> "POST"), array-aware.
    static String firstMemberName(ExpressionTree e) {
        if (e == null) return null;
        if (e instanceof MemberSelectTree) {
            return ((MemberSelectTree) e).getIdentifier().toString();
        }
        if (e instanceof IdentifierTree) {
            return ((IdentifierTree) e).getName().toString();
        }
        if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) {
                for (ExpressionTree it : inits) {
                    String s = firstMemberName(it);
                    if (s != null) return s;
                }
            }
        }
        return null;
    }

    // Concatenate a base path and a method path with a single slash. Either may
    // be null/empty. The result keeps a leading slash and collapses "//".
    static String joinPath(String base, String method) {
        String b = (base == null) ? "" : base.trim();
        String mth = (method == null) ? "" : method.trim();
        String joined;
        if (b.isEmpty()) joined = mth;
        else if (mth.isEmpty()) joined = b;
        else joined = b + "/" + mth;
        if (joined.isEmpty()) return "/";
        // collapse repeated slashes
        StringBuilder sb = new StringBuilder();
        boolean prevSlash = false;
        for (int i = 0; i < joined.length(); i++) {
            char c = joined.charAt(i);
            if (c == '/') {
                if (!prevSlash) sb.append(c);
                prevSlash = true;
            } else {
                sb.append(c);
                prevSlash = false;
            }
        }
        String out = sb.toString();
        if (!out.startsWith("/")) out = "/" + out;
        // drop a trailing slash except for the root path
        if (out.length() > 1 && out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }

    // ---- JPA / Spring Data tables ---------------------------------------------

    /** Relation annotation simple name -> the `relation` value emitted for it. */
    static final String[][] RELATION_ANNOTATIONS = {
        {"ManyToOne", "manyToOne"},
        {"OneToMany", "oneToMany"},
        {"OneToOne", "oneToOne"},
        {"ManyToMany", "manyToMany"},
    };

    /**
     * The `fetch =` attribute of a relation annotation, as one of JPA's two
     * FetchType constants. `FetchType.EAGER`, a static-imported `EAGER` and
     * `value = FetchType.EAGER` all read the same; anything else (an attribute
     * that is not written, a constant this file cannot resolve) is null, which
     * means "not written down" and leaves the default to the bridge.
     */
    static String fetchTypeOf(ExpressionTree e) {
        String name = firstMemberName(e);
        if ("EAGER".equals(name) || "LAZY".equals(name)) return name;
        return null;
    }

    /** The simple type name of a class literal (`Pet.class` -> "Pet"), or null. */
    static String classLiteralSimpleName(ExpressionTree e) {
        if (!(e instanceof MemberSelectTree)) return null;
        MemberSelectTree ms = (MemberSelectTree) e;
        if (!"class".equals(ms.getIdentifier().toString())) return null;
        return typeSimpleName(ms.getExpression());
    }

    /**
     * `@NamedEntityGraph(name = …, attributeNodes = {@NamedAttributeNode("pets")})`
     * on an entity, and every one inside a `@NamedEntityGraphs`. Each comes back as
     * {name, attributePaths}. A node's `subgraph =` is NOT read: a nested plan is a
     * fetch this lane does not follow, and half-following it would be worse than
     * saying so.
     */
    static List<Object> namedEntityGraphsOf(List<AnnotationTree> typeAnns) {
        List<Object> out = new ArrayList<>();
        for (AnnotationTree a : typeAnns) {
            String simple = typeSimpleName(a.getAnnotationType());
            if ("NamedEntityGraph".equals(simple)) addNamedEntityGraph(a, out);
            else if ("NamedEntityGraphs".equals(simple)) {
                for (AnnotationTree nested : nestedAnnotations(annAttr(a, "value"))) addNamedEntityGraph(nested, out);
            }
        }
        return out;
    }

    static void addNamedEntityGraph(AnnotationTree a, List<Object> out) {
        Map<String, Object> g = new LinkedHashMap<>();
        g.put("name", firstString(annAttr(a, "name")));
        List<String> paths = new ArrayList<>();
        for (AnnotationTree node : nestedAnnotations(annAttr(a, "attributeNodes"))) {
            String v = firstString(annAttr(node, "value"));
            if (v == null) v = firstString(annAttr(node, "name"));
            if (v != null) paths.add(v);
        }
        g.put("attributePaths", paths);
        out.add(g);
    }

    /**
     * `@EntityGraph` on a repository method: the paths it names outright
     * (`attributePaths = {"pets"}`) or the name of a plan the entity declares
     * (`value = "Owner.pets"`). Null when the method carries no @EntityGraph.
     */
    static Map<String, Object> entityGraphOf(List<AnnotationTree> ma) {
        AnnotationTree a = annNamed(ma, "EntityGraph");
        if (a == null) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("name", firstString(annAttr(a, "value")));
        out.put("attributePaths", stringValues(annAttr(a, "attributePaths")));
        return out;
    }

    /** Every nested annotation of an expression that may be one annotation or an array of them. */
    static List<AnnotationTree> nestedAnnotations(ExpressionTree e) {
        List<AnnotationTree> out = new ArrayList<>();
        if (e instanceof AnnotationTree) out.add((AnnotationTree) e);
        else if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) for (ExpressionTree it : inits) {
                if (it instanceof AnnotationTree) out.add((AnnotationTree) it);
            }
        }
        return out;
    }

    /** Every string literal of an expression that may be one literal or an array of them. */
    static List<String> stringValues(ExpressionTree e) {
        List<String> out = new ArrayList<>();
        if (e instanceof LiteralTree) {
            String s = firstString(e);
            if (s != null) out.add(s);
        } else if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) for (ExpressionTree it : inits) {
                String s = firstString(it);
                if (s != null) out.add(s);
            }
        }
        return out;
    }

    /**
     * The methods a type declares that carry `@ModelAttribute`. A PARAMETER may
     * carry the same annotation (`handler(@ModelAttribute Owner owner)`) and that
     * is a different thing entirely — a binding, not a method Spring runs — so only
     * the method's own modifiers are read. Declaration order, first spelling wins.
     */
    static List<String> modelAttributeMethodsOf(ClassTree ct) {
        List<String> out = new ArrayList<>();
        for (Tree member : ct.getMembers()) {
            if (!(member instanceof MethodTree)) continue;
            MethodTree m = (MethodTree) member;
            if (!annotationNames(m.getModifiers().getAnnotations()).contains("ModelAttribute")) continue;
            String name = m.getName().toString();
            if (!out.contains(name)) out.add(name);
        }
        return out;
    }

    /** Spring Data base repository interfaces this worker recognises by simple name. */
    static final String[] REPOSITORY_BASES = {
        "JpaRepository", "CrudRepository", "ListCrudRepository",
        "PagingAndSortingRepository", "ListPagingAndSortingRepository", "Repository",
    };


    // ---- MyBatis-Plus ---------------------------------------------------------

    /**
     * MyBatis's four statement annotations, in the order they are looked for. The
     * SIMPLE name is matched, because a mapper interface imports them
     * (`org.apache.ibatis.annotations.Select`) and this worker resolves no types.
     */
    static final String[] MAPPER_SQL_ANNOTATIONS = {"Select", "Insert", "Update", "Delete"};

    /**
     * The generic service CLASS whose `protected M baseMapper` field a subclass
     * inherits. Only the receiver of `baseMapper.selectList(…)` is read from it
     * here; which types ARE services is a rule (src/core/rules/packs/
     * mybatis-plus.json), and this name is knowledge the worker still holds.
     */
    static final String[] MP_SERVICE_IMPL_BASES = { "ServiceImpl" };

    /** Member annotations that make a class MyBatis-Plus persistence evidence. */
    static final String[] MP_MEMBER_ANNOTATIONS = { "TableId", "TableField", "TableLogic", "Version" };

    static boolean hasMpAnnotation(List<AnnotationTree> anns) {
        List<String> names = annotationNames(anns);
        for (String a : MP_MEMBER_ANNOTATIONS) if (names.contains(a)) return true;
        return false;
    }

    /**
     * The condition-wrapper types this worker recognises by simple name, and the
     * `wrapperKind` each is recorded as. `Wrapper`/`AbstractWrapper` are the
     * abstract spellings a parameter often uses: the KIND is unknown there, which
     * is a fact about the source and is recorded as such rather than guessed.
     */
    static final String[][] MP_WRAPPER_TYPES = {
        {"LambdaQueryWrapper", "lambda-query"},
        {"LambdaQueryChainWrapper", "lambda-query"},
        {"LambdaUpdateWrapper", "lambda-update"},
        {"LambdaUpdateChainWrapper", "lambda-update"},
        {"QueryWrapper", "query"},
        {"QueryChainWrapper", "query"},
        {"UpdateWrapper", "update"},
        {"UpdateChainWrapper", "update"},
        {"AbstractWrapper", "unknown"},
        {"AbstractLambdaWrapper", "unknown"},
        {"Wrapper", "unknown"},
    };

    /** The wrapperKind for a wrapper type's simple name, or null when it is not one. */
    static String wrapperKindOf(String simple) {
        if (simple == null) return null;
        for (String[] pair : MP_WRAPPER_TYPES) if (pair[0].equals(simple)) return pair[1];
        return null;
    }

    /**
     * The static factories that MAKE a wrapper (`Wrappers.lambdaQuery()`), and the
     * fluent starters a service/mapper offers (`service.lambdaQuery()`), mapped to
     * the kind of wrapper they return.
     */
    static final String[][] MP_WRAPPER_FACTORIES = {
        {"lambdaQuery", "lambda-query"},
        {"lambdaUpdate", "lambda-update"},
        {"query", "query"},
        {"update", "update"},
        {"emptyWrapper", "unknown"},
    };

    static String factoryKindOf(String name) {
        if (name == null) return null;
        for (String[] pair : MP_WRAPPER_FACTORIES) if (pair[0].equals(name)) return pair[1];
        return null;
    }

    /** Annotations that make a GETTER persistence evidence (property access). */
    static final String[] JPA_MEMBER_ANNOTATIONS = {
        "Column", "Id", "EmbeddedId", "Embedded", "Transient", "Basic", "Lob", "Version",
        "Enumerated", "Temporal", "ElementCollection", "JoinColumn", "JoinTable",
        "ManyToOne", "OneToMany", "OneToOne", "ManyToMany",
    };

    static boolean hasJpaAnnotation(List<AnnotationTree> anns) {
        List<String> names = annotationNames(anns);
        for (String a : JPA_MEMBER_ANNOTATIONS) if (names.contains(a)) return true;
        return false;
    }

    /** The JavaBeans property a getter names, or null when it is not a getter. */
    static String propertyNameOf(String methodName) {
        String rest;
        if (methodName.startsWith("get") && methodName.length() > 3) rest = methodName.substring(3);
        else if (methodName.startsWith("is") && methodName.length() > 2) rest = methodName.substring(2);
        else return null;
        if (!Character.isUpperCase(rest.charAt(0))) return null;
        // JavaBeans: `getURL` -> "URL", `getName` -> "name".
        if (rest.length() > 1 && Character.isUpperCase(rest.charAt(1))) return rest;
        return Character.toLowerCase(rest.charAt(0)) + rest.substring(1);
    }

    /** The annotation with this simple name, or null. */
    /**
     * THE STATEMENT ID A FIRST ARGUMENT NAMES, as far as one file can read it.
     *
     * A string literal is the whole answer: `"CmmnCodeManageDAO.selectCmmnCodeList"`
     * IS the key MyBatis looks the statement up by at run time, so there is
     * nothing to resolve. A bare identifier is answered only when THIS class
     * declares it as a `static final String` with a literal initializer — the
     * same map the view-name scan reads, for the same reason: both are in one
     * file, so the name is read rather than guessed.
     *
     * Anything else — a parameter, a concatenation, a constant of another class
     * — returns null and is counted by the caller. Measured on
     * egovframe-common-components: 1,289 of 1,298 call sites are plain literals.
     */
    static String statementIdOf(ExpressionTree first, Map<String, String> constants) {
        if (first == null) return null;
        String value = null;
        if (first instanceof LiteralTree) {
            Object v = ((LiteralTree) first).getValue();
            if (v instanceof String) value = (String) v;
        } else if (first instanceof IdentifierTree && constants != null) {
            value = constants.get(((IdentifierTree) first).getName().toString());
        }
        if (value == null) return null;
        return STATEMENT_ID_RE.matcher(value).matches() ? value : null;
    }

    /**
     * The same first argument read as an iBATIS BARE id: one identifier-shaped
     * word, no dot. Returns null for anything else, `stmtArg` having already
     * recorded what was written.
     */
    static String bareStatementIdOf(ExpressionTree first, Map<String, String> constants) {
        if (first == null) return null;
        String value = null;
        if (first instanceof LiteralTree) {
            Object v = ((LiteralTree) first).getValue();
            if (v instanceof String) value = (String) v;
        } else if (first instanceof IdentifierTree && constants != null) {
            value = constants.get(((IdentifierTree) first).getName().toString());
        }
        if (value == null) return null;
        return BARE_STATEMENT_ID_RE.matcher(value).matches() ? value : null;
    }

    /** How long an unreadable argument may be when it is quoted back in a census. */
    static final int EXPRESSION_SAMPLE_CHARS = 60;

    /** One expression as the source wrote it, on one line and bounded. */
    static String shortExpression(ExpressionTree e) {
        String text = String.valueOf(e).replaceAll("\\s+", " ").trim();
        return text.length() <= EXPRESSION_SAMPLE_CHARS ? text
                : text.substring(0, EXPRESSION_SAMPLE_CHARS) + "\u2026";
    }

    /**
     * The bean name a class's own stereotype annotation gives it, or null.
     * `@Service("x")` and `@Service(value = "x")` are the same declaration;
     * `@Service` with no value leaves Spring to decapitalise the class name,
     * which is a rule the BRIDGE applies, because only it can see whether two
     * classes would then claim the same name.
     */
    static String beanNameOf(List<AnnotationTree> anns) {
        for (AnnotationTree a : anns) {
            String simple = typeSimpleName(a.getAnnotationType());
            if (simple == null || !BEAN_NAME_TYPE_ANNOTATIONS.contains(simple)) continue;
            String v = firstString(unwrap(annAttr(a, "value")));
            if (v != null && !v.isEmpty()) return v;
        }
        return null;
    }

    /**
     * The bean name a FIELD asks for: `@Resource(name = "x")`, `@Qualifier("x")`
     * (which is what `@Autowired @Qualifier("x")` comes down to), or null.
     */
    static String injectedBeanNameOf(List<AnnotationTree> anns) {
        for (AnnotationTree a : anns) {
            String simple = typeSimpleName(a.getAnnotationType());
            if (simple == null) continue;
            String v = null;
            if (simple.equals("Resource")) v = firstString(unwrap(annAttr(a, "name")));
            else if (simple.equals("Qualifier")) v = firstString(unwrap(annAttr(a, "value")));
            if (v != null && !v.isEmpty()) return v;
        }
        return null;
    }

    static AnnotationTree annNamed(List<AnnotationTree> anns, String simple) {
        for (AnnotationTree a : anns) {
            if (simple.equals(typeSimpleName(a.getAnnotationType()))) return a;
        }
        return null;
    }

    /**
     * Simple names of a parameterized type's arguments (`Map<K,V>` -> [K, V]),
     * one per argument in its position. An argument with no class name (`?`, a
     * primitive) is null rather than left out: `ServiceImpl<?, User>` leaving
     * out the `?` would put User where the mapper goes.
     */
    static List<String> typeArgSimples(Tree t) {
        List<String> out = new ArrayList<>();
        if (t instanceof ParameterizedTypeTree) {
            for (Tree a : ((ParameterizedTypeTree) t).getTypeArguments()) out.add(typeSimpleName(a));
        }
        return out;
    }

    /** A type's name as the source writes it, without its type arguments or annotations: `a.b.C` in full, else `C`. */
    static String writtenName(Tree t) {
        if (t instanceof ParameterizedTypeTree) return writtenName(((ParameterizedTypeTree) t).getType());
        if (t instanceof AnnotatedTypeTree) return writtenName(((AnnotatedTypeTree) t).getUnderlyingType());
        if (t instanceof MemberSelectTree || t instanceof IdentifierTree) return t.toString();
        return null;
    }

    /** Every member/identifier name in an expression that may be a single value or an array. */
    static List<String> memberNames(ExpressionTree e) {
        List<String> out = new ArrayList<>();
        collectMemberNames(e, out);
        return out;
    }

    static void collectMemberNames(ExpressionTree e, List<String> out) {
        if (e == null) return;
        if (e instanceof MemberSelectTree) out.add(((MemberSelectTree) e).getIdentifier().toString());
        else if (e instanceof IdentifierTree) out.add(((IdentifierTree) e).getName().toString());
        else if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) for (ExpressionTree it : inits) collectMemberNames(it, out);
        }
    }

    /** The `name` of each nested `@JoinColumn`, for @JoinTable's two column lists. */
    static List<String> joinColumnNames(ExpressionTree e) {
        List<String> out = new ArrayList<>();
        collectJoinColumnNames(e, out);
        return out;
    }

    static void collectJoinColumnNames(ExpressionTree e, List<String> out) {
        if (e == null) return;
        if (e instanceof AnnotationTree) {
            String n = firstString(annAttr((AnnotationTree) e, "name"));
            if (n != null) out.add(n);
        } else if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) for (ExpressionTree it : inits) collectJoinColumnNames(it, out);
        }
    }

    /** One @JoinColumn: the name it writes and the column it references, each null when not written. */
    static Map<String, Object> joinColumnOf(AnnotationTree jc) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("name", firstString(annAttr(jc, "name")));
        c.put("referencedColumnName", firstString(annAttr(jc, "referencedColumnName")));
        return c;
    }

    /** Each @JoinColumn of a @JoinColumns value, in the order written. */
    static void collectJoinColumns(ExpressionTree e, List<Object> out) {
        if (e == null) return;
        if (e instanceof AnnotationTree) out.add(joinColumnOf((AnnotationTree) e));
        else if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) for (ExpressionTree it : inits) collectJoinColumns(it, out);
        }
    }

    /**
     * Each @AttributeOverride on an attribute, alone or inside
     * @AttributeOverrides: the attribute path it names (dotted for a nested one)
     * and the column name its @Column writes (null when it writes none).
     */
    static List<Object> attributeOverridesOf(List<AnnotationTree> anns) {
        List<Object> out = new ArrayList<>();
        AnnotationTree one = annNamed(anns, "AttributeOverride");
        if (one != null) collectAttributeOverrides(one, out);
        AnnotationTree many = annNamed(anns, "AttributeOverrides");
        if (many != null) collectAttributeOverrides(annAttr(many, "value"), out);
        return out;
    }

    static void collectAttributeOverrides(ExpressionTree e, List<Object> out) {
        if (e == null) return;
        if (e instanceof AnnotationTree) {
            AnnotationTree ao = (AnnotationTree) e;
            ExpressionTree col = annAttr(ao, "column");
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("name", firstString(annAttr(ao, "name")));
            o.put("column", (col instanceof AnnotationTree) ? firstString(annAttr((AnnotationTree) col, "name")) : null);
            out.add(o);
        } else if (e instanceof NewArrayTree) {
            List<? extends ExpressionTree> inits = ((NewArrayTree) e).getInitializers();
            if (inits != null) for (ExpressionTree it : inits) collectAttributeOverrides(it, out);
        }
    }

    /** A boolean literal annotation attribute (`nativeQuery = true`), or null. */
    static Boolean boolOf(ExpressionTree e) {
        if (e instanceof LiteralTree) {
            Object v = ((LiteralTree) e).getValue();
            if (v instanceof Boolean) return (Boolean) v;
        }
        return null;
    }

    // ---- small tree helpers ---------------------------------------------------
    static String kindOf(ClassTree ct) {
        switch (ct.getKind()) {
            case INTERFACE:       return "interface";
            case ENUM:            return "enum";
            case ANNOTATION_TYPE: return "interface"; // an annotation is an interface kind
            case RECORD:          return "class";
            case CLASS:
            default:              return "class";
        }
    }

    static List<AnnotationTree> annotationsOf(List<? extends AnnotationTree> anns) {
        List<AnnotationTree> out = new ArrayList<>();
        for (AnnotationTree a : anns) out.add(a);
        return out;
    }

    static List<String> annotationNames(List<? extends AnnotationTree> anns) {
        List<String> out = new ArrayList<>();
        for (AnnotationTree a : anns) {
            String s = typeSimpleName(a.getAnnotationType());
            if (s != null) out.add(s);
        }
        return out;
    }

    /** Each annotation's type as the source writes it (`a.b.C` or `C`), aligned with `annotationNames`. */
    static List<String> annotationsWritten(List<? extends AnnotationTree> anns) {
        List<String> out = new ArrayList<>();
        for (AnnotationTree a : anns) {
            if (typeSimpleName(a.getAnnotationType()) == null) continue;
            out.add(writtenName(a.getAnnotationType()));
        }
        return out;
    }

    // Simple (unqualified) name written for a type tree.
    static String typeSimpleName(Tree t) {
        if (t == null) return null;
        if (t instanceof IdentifierTree) {
            return ((IdentifierTree) t).getName().toString();
        }
        if (t instanceof MemberSelectTree) {
            return ((MemberSelectTree) t).getIdentifier().toString();
        }
        if (t instanceof ParameterizedTypeTree) {
            return typeSimpleName(((ParameterizedTypeTree) t).getType());
        }
        if (t instanceof ArrayTypeTree) {
            return typeSimpleName(((ArrayTypeTree) t).getType());
        }
        if (t instanceof AnnotatedTypeTree) {
            // `List<@NonNull User>`: a type-use annotation is not part of the name.
            return typeSimpleName(((AnnotatedTypeTree) t).getUnderlyingType());
        }
        // PrimitiveTypeTree, WildcardTree, etc.: no class/interface simple name.
        return null;
    }

    // ---- file collection ------------------------------------------------------
    static void collectJava(File f, List<File> out) {
        if (f == null) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids == null) return;
            Arrays.sort(kids, (a, b) -> a.getName().compareTo(b.getName()));
            for (File k : kids) collectJava(k, out);
        } else if (f.isFile() && f.getName().endsWith(".java")) {
            out.add(f);
        }
    }

    static String relativize(Path root, URI uri) {
        Path p;
        try {
            p = Paths.get(uri);
        } catch (Exception e) {
            p = Paths.get(uri.getPath());
        }
        p = p.toAbsolutePath().normalize();
        if (root != null) {
            try {
                return root.relativize(p).toString().replace(File.separatorChar, '/');
            } catch (IllegalArgumentException e) {
                // different roots: fall back to just the file name
            }
        }
        return p.getFileName().toString();
    }

    // =========================================================================
    // Output
    // =========================================================================
    static void emit(Sink sink) {
        Collections.sort(sink.records);

        PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);

        Map<String, Object> header = new LinkedHashMap<>();
        header.put("kind", "header");
        header.put("schema", SCHEMA);
        header.put("version", VERSION);
        header.put("files", sink.files);
        header.put("types", sink.types);
        header.put("endpoints", sink.endpoints);
        header.put("calls", sink.calls);
        header.put("methods", sink.methods);
        // The two halves of what this run did NOT emit an edge for. A per-RUN
        // tally, like every other number on the header: it rides on stdout so a
        // caller that never reads stderr can still say how much was skipped, and
        // it is dropped from the per-file shards on purpose (a run's tally means
        // nothing once its facts are cached per file).
        header.put("skippedCalls", sink.skippedCalls);
        header.put("skippedLocalReceivers", sink.skippedLocalReceivers);
        header.put("transactional", sink.transactional);
        header.put("entities", sink.entities);
        header.put("repositories", sink.repositories);
        header.put("mpEntities", sink.mpEntities);
        header.put("mpWrappers", sink.mpWrappers);
        header.put("mapperAnnotationSql", sink.mapperAnnotationSql);
        header.put("httpCalls", sink.httpCalls);
        header.put("views", sink.views);
        header.put("routeFunctions", sink.routeFunctions);
        header.put("parseErrors", sink.parseErrors);
        out.println(toJson(header));
        for (Rec r : sink.records) out.println(r.json);
        out.flush();

        PrintStream err = new PrintStream(System.err, true, StandardCharsets.UTF_8);
        for (Map<String, Object> d : sink.diagnostics) err.println(toJson(d));
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("level", "info");
        summary.put("code", "summary");
        summary.put("version", VERSION);
        summary.put("files", sink.files);
        summary.put("types", sink.types);
        summary.put("endpoints", sink.endpoints);
        summary.put("calls", sink.calls);
        summary.put("methods", sink.methods);
        summary.put("skippedCalls", sink.skippedCalls);
        summary.put("skippedLocalReceivers", sink.skippedLocalReceivers);
        summary.put("transactional", sink.transactional);
        summary.put("entities", sink.entities);
        summary.put("repositories", sink.repositories);
        summary.put("mpEntities", sink.mpEntities);
        summary.put("mpWrappers", sink.mpWrappers);
        summary.put("mapperAnnotationSql", sink.mapperAnnotationSql);
        summary.put("httpCalls", sink.httpCalls);
        summary.put("views", sink.views);
        summary.put("routeFunctions", sink.routeFunctions);
        summary.put("parseErrors", sink.parseErrors);
        err.println(toJson(summary));
        err.flush();
    }

    // Minimal, deterministic compact JSON writer (objects preserve insertion order).
    @SuppressWarnings("unchecked")
    static String toJson(Object o) {
        StringBuilder sb = new StringBuilder();
        writeJson(sb, o);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    static void writeJson(StringBuilder sb, Object o) {
        if (o == null) {
            sb.append("null");
        } else if (o instanceof String) {
            writeJsonString(sb, (String) o);
        } else if (o instanceof Integer || o instanceof Long) {
            sb.append(o.toString());
        } else if (o instanceof Boolean) {
            sb.append(((Boolean) o) ? "true" : "false");
        } else if (o instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                writeJsonString(sb, e.getKey());
                sb.append(':');
                writeJson(sb, e.getValue());
            }
            sb.append('}');
        } else if (o instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object it : (List<Object>) o) {
                if (!first) sb.append(',');
                first = false;
                writeJson(sb, it);
            }
            sb.append(']');
        } else {
            writeJsonString(sb, o.toString());
        }
    }

    static void writeJsonString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    static java.io.Writer nullWriter() {
        return new java.io.Writer() {
            public void write(char[] cbuf, int off, int len) { }
            public void flush() { }
            public void close() { }
        };
    }

    static String shortMsg(Throwable t) {
        String m = t.getMessage();
        String cls = t.getClass().getSimpleName();
        return (m != null) ? (cls + ": " + m) : cls;
    }
}
