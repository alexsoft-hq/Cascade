#!/usr/bin/env python3
"""Unit tests for adapters/sql/mybatis_extract.py (extract_statements).

Run:
    cd adapters/sql && ../../.venv/bin/python -m unittest test_mybatis_extract -v
"""

import json
import os
import shutil
import signal
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import mybatis_extract  # noqa: E402


def _dumps(rec):
    return json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class _Timeout(Exception):
    pass


def _timeout_handler(signum, frame):
    raise _Timeout("extract_statements did not return in time")


class TempDirTestCase(unittest.TestCase):
    """Base class: gives each test its own scratch directory for fixture files."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="mybatis_extract_test_")
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)

    def write(self, relname, content):
        """Write ``content`` to ``relname`` under the temp dir; return the full path."""
        path = os.path.join(self.tmpdir, relname)
        dirname = os.path.dirname(path)
        if dirname:
            os.makedirs(dirname, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)
        return path


# ---------------------------------------------------------------------------
# Header record
# ---------------------------------------------------------------------------

class HeaderRecordTests(TempDirTestCase):
    BASIC_MAPPER = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.ProductMapper">
  <sql id="Base_Column_List">id, name, price</sql>
  <select id="selectByPrimaryKey" resultType="map">
    select <include refid="Base_Column_List"/> from pms_product where id = #{id}
  </select>
</mapper>
"""

    def test_header_is_first_record(self):
        path = self.write("ProductMapper.xml", self.BASIC_MAPPER)
        recs = mybatis_extract.extract_statements([path])
        self.assertEqual(recs[0]["kind"], "header")

    def test_header_schema_constant(self):
        path = self.write("ProductMapper.xml", self.BASIC_MAPPER)
        recs = mybatis_extract.extract_statements([path])
        self.assertEqual(recs[0]["schema"], "cascade:mybatis-stmts:1")
        self.assertEqual(recs[0]["schema"], mybatis_extract.STMTS_SCHEMA)

    def test_header_counts_match_fixture(self):
        path = self.write("ProductMapper.xml", self.BASIC_MAPPER)
        recs = mybatis_extract.extract_statements([path])
        header = recs[0]
        self.assertEqual(header["files"], 1)
        self.assertEqual(header["statements"], 1)
        self.assertEqual(header["fragments"], 1)
        self.assertEqual(header["unresolvedIncludes"], 0)

    def test_header_fragment_count_multiple_fragments(self):
        two_frags = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.TwoFrags">
  <sql id="ColsA">a</sql>
  <sql id="ColsB">b</sql>
  <select id="selectSomething">select 1</select>
</mapper>
"""
        path = self.write("TwoFrags.xml", two_frags)
        recs = mybatis_extract.extract_statements([path])
        self.assertEqual(recs[0]["fragments"], 2)


# ---------------------------------------------------------------------------
# Statement basics
# ---------------------------------------------------------------------------

class StatementBasicsTests(TempDirTestCase):
    ALL_TYPES_MAPPER = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.AllTypes">
  <select id="doSelect">select 1 from t</select>
  <insert id="doInsert">insert into t (a) values (1)</insert>
  <update id="doUpdate">update t set a = 1</update>
  <delete id="doDelete">delete from t</delete>
</mapper>
"""

    def setUp(self):
        super().setUp()
        path = self.write("AllTypes.xml", self.ALL_TYPES_MAPPER)
        self.recs = mybatis_extract.extract_statements([path])
        self.statements = self.recs[1:]
        self.by_id = {r["id"]: r for r in self.statements}

    def test_statement_kind(self):
        for stmt in self.statements:
            self.assertEqual(stmt["kind"], "statement")

    def test_statement_namespace(self):
        for stmt in self.statements:
            self.assertEqual(stmt["namespace"], "ns.AllTypes")

    def test_statement_types_match_tag(self):
        self.assertEqual(self.by_id["doSelect"]["type"], "select")
        self.assertEqual(self.by_id["doInsert"]["type"], "insert")
        self.assertEqual(self.by_id["doUpdate"]["type"], "update")
        self.assertEqual(self.by_id["doDelete"]["type"], "delete")

    def test_statement_sql_is_nonempty_string(self):
        for stmt in self.statements:
            self.assertIsInstance(stmt["sql"], str)
            self.assertTrue(stmt["sql"].strip())

    def test_statements_sorted_by_namespace_then_id(self):
        zeta_alpha_mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Zeta">
  <select id="zzz">select 1</select>
  <select id="aaa">select 1</select>
</mapper>
"""
        alpha_mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Alpha">
  <select id="mmm">select 1</select>
</mapper>
"""
        p1 = self.write("Zeta.xml", zeta_alpha_mapper)
        p2 = self.write("Alpha.xml", alpha_mapper)
        recs = mybatis_extract.extract_statements([p1, p2])
        order = [(r["namespace"], r["id"]) for r in recs[1:]]
        self.assertEqual(order, [("ns.Alpha", "mmm"), ("ns.Zeta", "aaa"), ("ns.Zeta", "zzz")])


# ---------------------------------------------------------------------------
# Within-file <include> resolution
# ---------------------------------------------------------------------------

class WithinFileIncludeTests(TempDirTestCase):
    def test_include_resolved_to_fragment_text(self):
        mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.ProductMapper">
  <sql id="Base_Column_List">id, name, price</sql>
  <select id="selectByPrimaryKey">
    select <include refid="Base_Column_List"/> from pms_product where id = #{id}
  </select>
</mapper>
"""
        path = self.write("ProductMapper.xml", mapper)
        recs = mybatis_extract.extract_statements([path])
        stmt = recs[1]
        self.assertEqual(stmt["namespace"], "ns.ProductMapper")
        self.assertEqual(stmt["id"], "selectByPrimaryKey")
        self.assertIn("id, name, price", stmt["sql"])
        self.assertNotIn("include", stmt["sql"])
        self.assertNotIn("refid", stmt["sql"])


# ---------------------------------------------------------------------------
# Cross-file <include> resolution by namespace.refid
# ---------------------------------------------------------------------------

class CrossFileIncludeTests(TempDirTestCase):
    def test_cross_file_include_resolves_and_no_unresolved(self):
        mapper_a = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.A">
  <sql id="Cols">a, b</sql>
</mapper>
"""
        mapper_b = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.B">
  <select id="selectB">
    select <include refid="ns.A.Cols"/> from t
  </select>
</mapper>
"""
        path_a = self.write("MapperA.xml", mapper_a)
        path_b = self.write("MapperB.xml", mapper_b)
        recs = mybatis_extract.extract_statements([path_a, path_b])
        header = recs[0]
        stmt = next(r for r in recs[1:] if r["id"] == "selectB")

        self.assertIn("a, b", stmt["sql"])
        self.assertEqual(header["unresolvedIncludes"], 0)


# ---------------------------------------------------------------------------
# Unresolved include
# ---------------------------------------------------------------------------

class UnresolvedIncludeTests(TempDirTestCase):
    def test_unresolved_include_counted_and_diagnosed(self):
        mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Unresolved">
  <select id="selectMissing">
    select <include refid="Nope.Missing"/> from t
  </select>
</mapper>
"""
        path = self.write("Unresolved.xml", mapper)
        diagnostics = []
        recs = mybatis_extract.extract_statements([path], diagnostics=diagnostics)
        header = recs[0]
        stmt = recs[1]

        # The statement still appears despite the unresolved include.
        self.assertEqual(stmt["namespace"], "ns.Unresolved")
        self.assertEqual(stmt["id"], "selectMissing")

        self.assertEqual(header["unresolvedIncludes"], 1)

        matching = [d for d in diagnostics if d.get("code") == "unresolved_include"]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]["namespace"], "ns.Unresolved")
        self.assertEqual(matching[0]["refid"], "Nope.Missing")
        self.assertEqual(matching[0]["level"], "warn")


# ---------------------------------------------------------------------------
# Include cycle
# ---------------------------------------------------------------------------

class IncludeCycleTests(TempDirTestCase):
    def test_include_cycle_does_not_hang_and_is_diagnosed(self):
        mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Cycle">
  <sql id="P"><include refid="Q"/></sql>
  <sql id="Q"><include refid="P"/></sql>
  <select id="selectCycle">
    select <include refid="P"/> from t
  </select>
</mapper>
"""
        path = self.write("Cycle.xml", mapper)
        diagnostics = []

        has_alarm = hasattr(signal, "SIGALRM")
        if has_alarm:
            old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
            signal.alarm(5)
        try:
            recs = mybatis_extract.extract_statements([path], diagnostics=diagnostics)
        except _Timeout:
            self.fail("extract_statements hung on an include cycle")
        finally:
            if has_alarm:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, old_handler)

        # It returns, the statement is still present, and a cycle is diagnosed.
        self.assertEqual(recs[1]["id"], "selectCycle")
        cycle_diags = [d for d in diagnostics if d.get("code") == "include_cycle"]
        self.assertEqual(len(cycle_diags), 1)
        self.assertEqual(cycle_diags[0]["fragment"], "ns.Cycle.P")


# ---------------------------------------------------------------------------
# #{param} -> ?
# ---------------------------------------------------------------------------

class BindParameterTests(TempDirTestCase):
    def test_bind_param_becomes_question_mark(self):
        mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Bind">
  <select id="selectBind">
    select * from t where id = #{id,jdbcType=BIGINT}
  </select>
</mapper>
"""
        path = self.write("Bind.xml", mapper)
        recs = mybatis_extract.extract_statements([path])
        sql = recs[1]["sql"]
        self.assertIn(mybatis_extract._BIND_PLACEHOLDER, sql)
        self.assertNotIn("#{", sql)
        self.assertIn("id = ?", sql)


# ---------------------------------------------------------------------------
# ${param} -> substitution placeholder + hasStringSubst
# ---------------------------------------------------------------------------

class StringSubstitutionTests(TempDirTestCase):
    def setUp(self):
        super().setUp()
        mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Subst">
  <select id="selectSubst">
    select * from t order by ${orderBy}
  </select>
  <select id="selectPlain">
    select * from t
  </select>
</mapper>
"""
        path = self.write("Subst.xml", mapper)
        recs = mybatis_extract.extract_statements([path])
        self.by_id = {r["id"]: r for r in recs[1:]}

    def test_dollar_param_replaced_with_subst_placeholder(self):
        sql = self.by_id["selectSubst"]["sql"]
        self.assertIn(mybatis_extract._SUBST_PLACEHOLDER, sql)
        self.assertNotIn("${", sql)

    def test_dollar_param_sets_has_string_subst_true(self):
        self.assertTrue(self.by_id["selectSubst"]["hasStringSubst"])

    def test_statement_without_dollar_param_has_string_subst_false(self):
        stmt = self.by_id["selectPlain"]
        self.assertFalse(stmt["hasStringSubst"])
        self.assertNotIn(mybatis_extract._SUBST_PLACEHOLDER, stmt["sql"])


# ---------------------------------------------------------------------------
# Dynamic tag flattening
# ---------------------------------------------------------------------------

class DynamicTagFlattenTests(TempDirTestCase):
    def test_where_strips_leading_and(self):
        mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Dyn">
  <select id="selectWhere">
    select * from t
    <where> AND a=1 </where>
  </select>
</mapper>
"""
        path = self.write("DynWhere.xml", mapper)
        recs = mybatis_extract.extract_statements([path])
        sql = recs[1]["sql"]
        self.assertIn("WHERE a=1", sql)
        self.assertNotIn("WHERE AND", sql)

    def test_set_strips_trailing_comma(self):
        mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Dyn">
  <update id="updateSet">
    update t
    <set> a=#{a}, </set>
    where id = #{id}
  </update>
</mapper>
"""
        path = self.write("DynSet.xml", mapper)
        recs = mybatis_extract.extract_statements([path])
        sql = recs[1]["sql"]
        self.assertIn("SET a=?", sql)
        self.assertNotIn("a=?,", sql)

    def test_foreach_folds_open_close_delimiters(self):
        mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Dyn">
  <insert id="insertForeach">
    insert into t (x) values
    <foreach collection="list" item="x" open="(" close=")" separator=",">
      #{x}
    </foreach>
  </insert>
</mapper>
"""
        path = self.write("DynForeach.xml", mapper)
        recs = mybatis_extract.extract_statements([path])
        sql = recs[1]["sql"]
        self.assertIn("(", sql)
        self.assertIn(")", sql)
        self.assertIn("?", sql)

    def test_select_key_dropped_from_host_statement(self):
        mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Dyn">
  <insert id="insertWithKey">
    insert into t (name) values (#{name})
    <selectKey keyProperty="id" resultType="long" order="AFTER">
      SELECT LAST_INSERT_ID()
    </selectKey>
  </insert>
</mapper>
"""
        path = self.write("DynSelectKey.xml", mapper)
        diagnostics = []
        recs = mybatis_extract.extract_statements([path], diagnostics=diagnostics)
        sql = recs[1]["sql"]

        # The selectKey's own SQL must not leak into the host insert.
        self.assertNotIn("LAST_INSERT_ID", sql)
        # The host statement's own SQL is still present.
        self.assertIn("insert into t", sql)

        # The module's actual behavior: dropped, not emitted as its own statement.
        self.assertEqual(len(recs) - 1, 1)  # only the <insert>, no separate record

        dropped_diags = [d for d in diagnostics if d.get("code") == "dropped_selectkey"]
        self.assertEqual(len(dropped_diags), 1)
        self.assertEqual(dropped_diags[0]["level"], "info")


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------

class DeterminismTests(TempDirTestCase):
    def test_repeated_calls_return_equal_lists(self):
        mapper_a = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.A">
  <sql id="Cols">a, b</sql>
</mapper>
"""
        mapper_b = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.B">
  <select id="selectB">
    select <include refid="ns.A.Cols"/> from t where id = #{id} and x = ${x}
  </select>
</mapper>
"""
        path_a = self.write("MapperA.xml", mapper_a)
        path_b = self.write("MapperB.xml", mapper_b)

        r1 = mybatis_extract.extract_statements([path_a, path_b])
        r2 = mybatis_extract.extract_statements([path_a, path_b])
        self.assertEqual(r1, r2)

    def test_repeated_calls_produce_byte_identical_json(self):
        mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Det">
  <select id="selectOne">select * from t where id = #{id}</select>
</mapper>
"""
        path = self.write("Det.xml", mapper)
        r1 = mybatis_extract.extract_statements([path])
        r2 = mybatis_extract.extract_statements([path])
        d1 = [_dumps(rec) for rec in r1]
        d2 = [_dumps(rec) for rec in r2]
        self.assertEqual(d1, d2)


# ---------------------------------------------------------------------------
# file / line fields
# ---------------------------------------------------------------------------

class FileLineTests(TempDirTestCase):
    LINE_MAPPER = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.LineMapper">
  <select id="selectOne">
    select 1
  </select>
</mapper>
"""

    def test_file_relative_to_root_not_absolute(self):
        path = self.write("mappers/LineMapper.xml", self.LINE_MAPPER)
        recs = mybatis_extract.extract_statements([path], root=self.tmpdir)
        stmt = recs[1]
        self.assertFalse(os.path.isabs(stmt["file"]))
        self.assertEqual(stmt["file"], "mappers/LineMapper.xml")

    def test_file_falls_back_to_basename_without_root(self):
        path = self.write("mappers/LineMapper.xml", self.LINE_MAPPER)
        recs = mybatis_extract.extract_statements([path])
        stmt = recs[1]
        self.assertFalse(os.path.isabs(stmt["file"]))
        self.assertEqual(stmt["file"], "LineMapper.xml")

    def test_line_points_near_the_statement(self):
        path = self.write("LineMapper.xml", self.LINE_MAPPER)
        recs = mybatis_extract.extract_statements([path])
        line = recs[1]["line"]
        self.assertTrue(line is None or (isinstance(line, int) and line > 0))
        # This fixture's <select> opens on line 3 (1-based): xml decl, <mapper>, <select>.
        self.assertEqual(line, 3)


# ---------------------------------------------------------------------------
# Robustness
# ---------------------------------------------------------------------------

class RobustnessTests(TempDirTestCase):
    def test_malformed_xml_diagnosed_good_files_still_extracted(self):
        good = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Good">
  <select id="ok">select 1</select>
</mapper>
"""
        bad = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Bad"><select id="broken">select 1
"""  # deliberately unclosed -> not well-formed XML
        good_path = self.write("Good.xml", good)
        bad_path = self.write("Bad.xml", bad)
        diagnostics = []
        recs = mybatis_extract.extract_statements([good_path, bad_path], diagnostics=diagnostics)

        header = recs[0]
        self.assertEqual(header["files"], 1)
        self.assertEqual(header["statements"], 1)
        self.assertEqual(recs[1]["id"], "ok")

        parse_errors = [d for d in diagnostics if d.get("code") == "xml_parse_error"]
        self.assertEqual(len(parse_errors), 1)
        self.assertEqual(parse_errors[0]["level"], "warn")
        self.assertEqual(parse_errors[0]["file"], "Bad.xml")

    def test_non_mapper_root_skipped_with_diagnostic(self):
        not_a_mapper = """<?xml version="1.0" encoding="UTF-8"?>
<foo><bar/></foo>
"""
        path = self.write("NotAMapper.xml", not_a_mapper)
        diagnostics = []
        recs = mybatis_extract.extract_statements([path], diagnostics=diagnostics)

        header = recs[0]
        self.assertEqual(header["files"], 0)
        self.assertEqual(header["statements"], 0)
        self.assertEqual(len(recs), 1)  # header only, no statement records

        not_mapper_diags = [d for d in diagnostics if d.get("code") == "not_a_mapper"]
        self.assertEqual(len(not_mapper_diags), 1)
        self.assertEqual(not_mapper_diags[0]["level"], "info")
        self.assertEqual(not_mapper_diags[0]["file"], "NotAMapper.xml")

    def test_unreadable_file_diagnosed_without_crashing(self):
        missing_path = os.path.join(self.tmpdir, "does_not_exist.xml")
        diagnostics = []
        recs = mybatis_extract.extract_statements([missing_path], diagnostics=diagnostics)

        header = recs[0]
        self.assertEqual(header["files"], 0)
        self.assertEqual(header["statements"], 0)

        read_failed = [d for d in diagnostics if d.get("code") == "file_read_failed"]
        self.assertEqual(len(read_failed), 1)
        self.assertEqual(read_failed[0]["level"], "warn")

    def test_diagnostics_none_is_safe_and_does_not_change_records(self):
        mapper = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Safe">
  <select id="ok">select 1</select>
</mapper>
"""
        path = self.write("Safe.xml", mapper)
        with_none = mybatis_extract.extract_statements([path], diagnostics=None)
        collected = []
        with_list = mybatis_extract.extract_statements([path], diagnostics=collected)
        self.assertEqual(with_none, with_list)


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------
# Schema qualifiers: ${prop}.table (SPEC §6.2 schema.propertyNames, I-4)
# ---------------------------------------------------------------------------

class SchemaQualifierTests(TempDirTestCase):
    MAPPER = """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="ns.Schema">
  <select id="qualified">
    select id from ${dbMain}.tb_user where id = #{id}
  </select>
  <select id="undeclared">
    select id from ${dbOther}.tb_log
  </select>
  <select id="orderBy">
    select id from tb_user order by ${orderBy}
  </select>
</mapper>
"""

    def extract(self, **kw):
        path = self.write("Schema.xml", self.MAPPER)
        recs = mybatis_extract.extract_statements([path], **kw)
        return {r["id"]: r for r in recs[1:]}, recs[0]

    def test_declared_property_with_default_schema_becomes_the_schema(self):
        by_id, header = self.extract(default_schema="mall",
                                     schema_properties=["dbMain"])
        stmt = by_id["qualified"]
        self.assertIn("from mall.tb_user", stmt["sql"])
        self.assertNotIn(mybatis_extract._SUBST_PLACEHOLDER, stmt["sql"])
        # It was interpreted, so it is not a raw substitution any more.
        self.assertFalse(stmt["hasStringSubst"])
        self.assertFalse(stmt["schemaUnknown"])
        self.assertEqual(header["schemaUnknownStatements"], 0)

    def test_declared_property_without_default_drops_the_qualifier_and_flags_it(self):
        # I-4: never invent a schema name. The qualifier goes, the flag stays.
        by_id, header = self.extract(schema_properties=["dbMain"])
        stmt = by_id["qualified"]
        self.assertIn("from tb_user", stmt["sql"])
        self.assertNotIn("mall", stmt["sql"])
        self.assertTrue(stmt["schemaUnknown"])
        self.assertFalse(stmt["hasStringSubst"])
        self.assertEqual(header["schemaUnknownStatements"], 1)

    def test_undeclared_property_stays_a_raw_substitution(self):
        by_id, _ = self.extract(default_schema="mall",
                                schema_properties=["dbMain"])
        stmt = by_id["undeclared"]
        self.assertIn(mybatis_extract._SUBST_PLACEHOLDER, stmt["sql"])
        self.assertTrue(stmt["hasStringSubst"])
        self.assertFalse(stmt["schemaUnknown"])

    def test_a_dollar_token_that_is_not_a_qualifier_is_untouched(self):
        by_id, _ = self.extract(default_schema="mall",
                                schema_properties=["dbMain", "orderBy"])
        # `order by ${orderBy}` is followed by no dot, so it is not a qualifier.
        stmt = by_id["orderBy"]
        self.assertIn(mybatis_extract._SUBST_PLACEHOLDER, stmt["sql"])
        self.assertTrue(stmt["hasStringSubst"])

    def test_no_schema_properties_declared_keeps_todays_behaviour(self):
        by_id, header = self.extract()
        self.assertIn(mybatis_extract._SUBST_PLACEHOLDER, by_id["qualified"]["sql"])
        self.assertTrue(by_id["qualified"]["hasStringSubst"])
        self.assertFalse(by_id["qualified"]["schemaUnknown"])
        self.assertEqual(header["schemaUnknownStatements"], 0)

    def test_cli_accepts_repeatable_schema_property(self):
        path = self.write("Schema.xml", self.MAPPER)
        import io
        import contextlib
        out = io.StringIO()
        err = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mybatis_extract.main([
                "--default-schema", "mall",
                "--schema-property", "dbMain",
                "--schema-property", "dbOther",
                path,
            ])
        self.assertEqual(rc, 0)
        recs = [json.loads(l) for l in out.getvalue().splitlines() if l]
        by_id = {r["id"]: r for r in recs[1:]}
        self.assertIn("from mall.tb_user", by_id["qualified"]["sql"])
        self.assertIn("from mall.tb_log", by_id["undeclared"]["sql"])


# ---------------------------------------------------------------------------
# iBATIS 2: <sqlMap>, `#x#`, `$x$`, <dynamic>/<isNotNull>/<iterate>
# ---------------------------------------------------------------------------

class IbatisSqlMapTests(TempDirTestCase):
    SQLMAP = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE sqlMap PUBLIC "-//iBATIS.com//DTD SQL Map 2.0//EN" "http://ibatis.apache.org/dtd/sql-map-2.dtd">
<sqlMap namespace="Sample">
    <typeAlias alias="userVO" type="sample.vo.UserVO"/>
    <resultMap id="user" class="userVO">
        <result property="userId" column="USER_ID"/>
    </resultMap>

    <select id="selectUserVOList" parameterClass="userVO" resultMap="user">
        SELECT USER_ID, USER_NAME FROM TB_USER WHERE 1=2
        <dynamic>
            <isNotNull property="searchKeyword">
                <isEqual prepend=" OR " property="searchCondition" compareValue="NAME">
                 USER_NAME LIKE #searchKeyword#
                </isEqual>
                <isEqual prepend=" OR " property="searchCondition" compareValue="ID">
                 USER_ID LIKE #searchKeyword#
                </isEqual>
            </isNotNull>
        </dynamic>
    </select>

    <select id="selectByDept" parameterClass="userVO" resultMap="user">
        SELECT USER_ID FROM TB_USER
        <dynamic prepend="WHERE">
            <isNotNull prepend="AND" property="deptId">
                DEPT_ID = #deptId#
            </isNotNull>
        </dynamic>
        ORDER BY $sortColumn$
    </select>

    <select id="selectInList" parameterClass="userVO" resultMap="user">
        SELECT USER_ID FROM TB_USER WHERE USER_ID IN
        <iterate open="(" close=")" conjunction="," property="ids">
            #ids[]#
        </iterate>
    </select>

    <insert id="insertUserVO" parameterClass="userVO">
        <![CDATA[
        INSERT INTO TB_USER (USER_ID, USER_NAME) VALUES (#userId#, #userName#)
        ]]>
    </insert>

    <statement id="touchUser" parameterClass="userVO">
        UPDATE TB_USER SET UPDT_DT = now() WHERE USER_ID = #userId#
    </statement>

    <procedure id="callUserProc" parameterClass="userVO">
        { call sp_user(#userId#) }
    </procedure>
</sqlMap>
"""

    CONFIG_ON = """<?xml version="1.0" encoding="UTF-8"?>
<sqlMapConfig>
    <settings useStatementNamespaces="true"/>
    <sqlMap resource="sqlmap/Sample.xml"/>
</sqlMapConfig>
"""

    CONFIG_OFF = """<?xml version="1.0" encoding="UTF-8"?>
<sqlMapConfig>
    <settings useStatementNamespaces="false"/>
    <sqlMap resource="sqlmap/Sample.xml"/>
</sqlMapConfig>
"""

    def extract(self, *extra):
        paths = [self.write("sqlmap/Sample.xml", self.SQLMAP)]
        paths.extend(extra)
        diags = []
        recs = mybatis_extract.extract_statements(paths, root=self.tmpdir, diagnostics=diags)
        return {r["id"]: r for r in recs[1:]}, recs[0], diags

    def test_a_sqlmap_is_a_mapper_and_all_six_statement_tags_are_read(self):
        by_id, header, _ = self.extract()
        self.assertEqual(header["sqlMapFiles"], 1)
        self.assertEqual(
            sorted(by_id),
            ["callUserProc", "insertUserVO", "selectByDept", "selectInList",
             "selectUserVOList", "touchUser"])
        self.assertEqual(by_id["touchUser"]["type"], "statement")
        self.assertEqual(by_id["callUserProc"]["type"], "procedure")

    def test_hash_is_a_bind_parameter_and_dollar_is_a_substitution(self):
        by_id, _, _ = self.extract()
        insert = by_id["insertUserVO"]
        self.assertIn("VALUES (?, ?)", insert["sql"])
        self.assertFalse(insert["hasStringSubst"])
        by_dept = by_id["selectByDept"]
        self.assertIn(mybatis_extract._SUBST_PLACEHOLDER, by_dept["sql"])
        self.assertTrue(by_dept["hasStringSubst"])

    def test_a_dynamic_with_a_prepend_drops_the_first_conjunction_under_it(self):
        by_id, _, _ = self.extract()
        sql = by_id["selectByDept"]["sql"]
        self.assertIn("FROM TB_USER WHERE DEPT_ID = ?", sql)
        self.assertNotIn("WHERE AND", sql)

    def test_a_dynamic_with_no_prepend_keeps_the_conjunctions_it_is_joined_by(self):
        by_id, _, _ = self.extract()
        sql = by_id["selectUserVOList"]["sql"]
        self.assertIn("WHERE 1=2 OR USER_NAME LIKE ? OR USER_ID LIKE ?", sql)

    def test_an_iterate_folds_its_open_and_close_in_and_keeps_the_body_once(self):
        by_id, _, _ = self.extract()
        sql = by_id["selectInList"]["sql"]
        self.assertIn("IN ( ? )", sql)

    def test_the_bare_id_is_the_key_when_the_config_says_nothing(self):
        by_id, header, _ = self.extract()
        self.assertFalse(header["statementNamespaces"])
        self.assertEqual(by_id["selectUserVOList"]["namespace"], "")

    def test_the_namespace_joins_the_key_when_the_config_turns_it_on(self):
        cfg = self.write("sqlmap/sql-map-config.xml", self.CONFIG_ON)
        by_id, header, _ = self.extract(cfg)
        self.assertTrue(header["statementNamespaces"])
        self.assertEqual(by_id["selectUserVOList"]["namespace"], "Sample")

    def test_two_configs_that_disagree_are_reported_and_the_default_stands(self):
        on = self.write("sqlmap/on/sql-map-config.xml", self.CONFIG_ON)
        off = self.write("sqlmap/off/sql-map-config.xml", self.CONFIG_OFF)
        _, header, diags = self.extract(on, off)
        self.assertFalse(header["statementNamespaces"])
        self.assertEqual([d["code"] for d in diags if d["code"] == "statement_namespaces_conflict"],
                         ["statement_namespaces_conflict"])

    def test_one_id_declared_twice_is_a_named_diagnostic_not_a_silent_merge(self):
        second = self.write("sqlmap/Other.xml", self.SQLMAP.replace('namespace="Sample"', 'namespace="Other"'))
        _, _, diags = self.extract(second)
        dupes = [d for d in diags if d["code"] == "duplicate_statement_id"]
        self.assertEqual(len(dupes), 6)
        self.assertEqual(sorted(d["statement"] for d in dupes),
                         ["callUserProc", "insertUserVO", "selectByDept", "selectInList",
                          "selectUserVOList", "touchUser"])

    def test_a_mapper_and_a_sqlmap_in_one_run_are_one_statement_axis(self):
        mapper = self.write("mapper/User.xml", """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="sample.UserMapper">
  <select id="findOne">select ID from TB_USER where ID = #{id}</select>
</mapper>
""")
        by_id, header, _ = self.extract(mapper)
        self.assertEqual(header["files"], 2)
        self.assertEqual(header["sqlMapFiles"], 1)
        self.assertEqual(by_id["findOne"]["namespace"], "sample.UserMapper")
        self.assertIn("ID = ?", by_id["findOne"]["sql"])
        self.assertEqual(by_id["selectUserVOList"]["namespace"], "")

    def test_a_hash_in_a_mybatis_mapper_is_left_exactly_where_it_is(self):
        mapper = self.write("mapper/Odd.xml", """<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="odd">
  <select id="odd">select '#tag#' as t from TB_USER where ID = #{id}</select>
</mapper>
""")
        diags = []
        recs = mybatis_extract.extract_statements([mapper], root=self.tmpdir, diagnostics=diags)
        by_id = {r["id"]: r for r in recs[1:]}
        self.assertIn("'#tag#'", by_id["odd"]["sql"])

    def test_files_from_reads_a_list_instead_of_walking(self):
        self.write("sqlmap/Sample.xml", self.SQLMAP)
        other = self.write("sqlmap/Other.xml", self.SQLMAP.replace('namespace="Sample"', 'namespace="Other"'))
        listing = self.write("only.txt", other + "\n")
        import io
        import contextlib
        out = io.StringIO()
        err = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mybatis_extract.main(["--root", self.tmpdir, "--files-from", listing])
        self.assertEqual(rc, 0)
        recs = [json.loads(l) for l in out.getvalue().splitlines() if l]
        self.assertEqual(recs[0]["files"], 1)
        self.assertEqual({r["file"] for r in recs[1:]}, {"sqlmap/Other.xml"})
