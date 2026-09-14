<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<%@ taglib prefix="form" uri="http://www.springframework.org/tags/form" %>
<script type="text/javascript">
function fn_all() {
    var varForm = document.all["legacyForm"];
    varForm.action = "<c:url value='/things/list.do'/>";
    varForm.submit();
}
function fn_fallback() {
    var varFrom = document.getElementById("legacyForm") || document.forms["legacyForm"];
    varFrom.action = "<c:url value='/things/list.do'/>";
    varFrom.submit();
}
function fn_model() {
    var g = document.getElementById("thingVO");
    g.action = "<c:url value='/things/detail.do'/>";
    g.submit();
}
function fn_built() {
    var f = document.createElement("form");
    f.method = "post";
    f.action = "<c:url value='/things/detail.do'/>";
    f.submit();
}
function fn_built_default() {
    var h = document.createElement("form");
    h.action = "<c:url value='/things/list.do'/>";
    h.submit();
}
function fn_param(form) {
    form.action = "<c:url value='/things/detail.do'/>";
    form.submit();
}
</script>
<form name="legacyForm" method="get"></form>
<form:form modelAttribute="thingVO"></form:form>
