#!/usr/bin/env python3
"""Unit tests for adapters/sql/identifier_case.py (the declared identity rule).

Run:
    cd adapters/sql && ../../.venv/bin/python -m unittest test_identifier_case -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import identifier_case as ic  # noqa: E402


class DialectTableTests(unittest.TestCase):
    """One row per database, and the row is the DOCUMENTED behaviour."""

    def test_every_dialect_has_the_rule_its_manual_states(self):
        self.assertEqual(ic.identifier_case_for_dialect("mysql"), "fold-lower")
        self.assertEqual(ic.identifier_case_for_dialect("mariadb"), "fold-lower")
        self.assertEqual(ic.identifier_case_for_dialect("postgres"), "fold-lower")
        self.assertEqual(ic.identifier_case_for_dialect("postgresql"), "fold-lower")
        self.assertEqual(ic.identifier_case_for_dialect("oracle"), "fold-upper")
        self.assertEqual(ic.identifier_case_for_dialect("oracle-11g"), "fold-upper")
        self.assertEqual(ic.identifier_case_for_dialect("oracle-19c"), "fold-upper")
        self.assertEqual(ic.identifier_case_for_dialect("hsqldb"), "fold-upper")
        self.assertEqual(ic.identifier_case_for_dialect("h2"), "fold-upper")

    def test_an_unknown_dialect_folds_NOTHING(self):
        # Fail closed: a fold we cannot cite would merge two different tables.
        self.assertEqual(ic.identifier_case_for_dialect("db2"), "exact")
        self.assertEqual(ic.identifier_case_for_dialect(None), "exact")
        # sqlglot's default (ANSI) parser is not a database and has no rule.
        self.assertEqual(ic.identifier_case_for_dialect(""), "exact")


class FoldTests(unittest.TestCase):
    def test_fold_lower_and_upper(self):
        self.assertEqual(ic.fold_identifier("Item", "fold-lower"), "item")
        self.assertEqual(ic.fold_identifier("Item", "fold-upper"), "ITEM")
        self.assertEqual(ic.fold_identifier("pms_product", "fold-upper"), "PMS_PRODUCT")

    def test_exact_folds_nothing(self):
        self.assertEqual(ic.fold_identifier("Item", "exact"), "Item")

    def test_none_passes_through(self):
        self.assertIsNone(ic.fold_identifier(None, "fold-lower"))

    def test_digits_and_underscores_are_untouched(self):
        self.assertEqual(ic.fold_identifier("T_1_x", "fold-upper"), "T_1_X")

    def test_non_ascii_is_matched_exactly_in_both_directions(self):
        # Deliberate: case folding outside ASCII is locale- and server-dependent
        # (the Turkish dotless i), and this rule has a JavaScript mirror that has
        # to agree byte for byte. So non-ASCII letters are left alone.
        for name in ["ß", "Ω", "ω", "É", "é", "İ"]:
            self.assertEqual(ic.fold_identifier(name, "fold-lower"), name)
            self.assertEqual(ic.fold_identifier(name, "fold-upper"), name)
        # ASCII letters inside a non-ASCII name still fold; the non-ASCII ones
        # do not. (Python's own str.upper() would give 'ÉTÉ' here, and
        # JavaScript's toUpperCase() would agree — but str.lower() and
        # toLowerCase() disagree on 'İ', which is why neither is used.)
        self.assertEqual(ic.fold_identifier("Été", "fold-upper"), "ÉTé")
        self.assertEqual(ic.fold_identifier("İstanbul", "fold-lower"), "İstanbul")
        self.assertEqual(ic.fold_identifier("İSTANBUL", "fold-lower"), "İstanbul")

    def test_an_unknown_rule_raises_rather_than_guessing(self):
        with self.assertRaises(ic.IdentifierCaseError):
            ic.fold_identifier("x", "lower")


class SqlglotDialectTests(unittest.TestCase):
    """The rule declared here must also be the one SQLGlot applies internally."""

    def test_each_rule_maps_to_a_sqlglot_normalization_strategy(self):
        self.assertEqual(ic.sqlglot_dialect("mysql", "fold-lower"),
                         "mysql,normalization_strategy=lowercase")
        self.assertEqual(ic.sqlglot_dialect("oracle", "fold-upper"),
                         "oracle,normalization_strategy=uppercase")
        self.assertEqual(ic.sqlglot_dialect("mysql", "exact"),
                         "mysql,normalization_strategy=case_sensitive")

    def test_the_default_parser_takes_settings_too(self):
        self.assertEqual(ic.sqlglot_dialect("", "fold-upper"),
                         ",normalization_strategy=uppercase")
        self.assertEqual(ic.sqlglot_dialect(None, "fold-upper"),
                         ",normalization_strategy=uppercase")

    def test_sqlglot_accepts_what_this_builds(self):
        from sqlglot.dialects.dialect import Dialect
        for dialect in ["mysql", "oracle", "postgres", ""]:
            for case, expected in [("fold-lower", "LOWERCASE"),
                                   ("fold-upper", "UPPERCASE"),
                                   ("exact", "CASE_SENSITIVE")]:
                d = Dialect.get_or_raise(ic.sqlglot_dialect(dialect, case))
                self.assertEqual(d.normalization_strategy.name, expected,
                                 "%s / %s" % (dialect, case))


if __name__ == "__main__":
    unittest.main()
