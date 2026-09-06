package com.example;

// A MyBatis mapper interface: its methods bind to statements in an XML mapper
// of the same namespace (none is needed here — the smoke check only reads the
// java facts).
public interface OrderMapper {
    String selectById(String id);
}
