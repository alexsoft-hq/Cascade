<%@ page contentType="text/html; charset=utf-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<%@ taglib prefix="form" uri="http://www.springframework.org/tags/form"%>
<html>
<head>
<script type="text/javascript">
	/* the spelling every eGovFrame page uses: document.<name> */
	function goDetail(id) {
		document.listForm.id.value = id;
		document.listForm.action = "<c:url value='/things/detail.do'/>";
		document.listForm.submit();
	}

	/* the method assigned between the two halves wins over the element's */
	function goList(pageNo) {
		document.listForm.pageIndex.value = pageNo;
		document.listForm.action = "<c:url value='/things/list.do'/>";
		document.listForm.method = "get";
		document.listForm.submit();
	}

	/* document.forms['name'] is the same form */
	function goRemove() {
		document.forms['listForm'].action = "<c:url value='/things/remove.do'/>";
		document.forms['listForm'].submit();
	}

	/* a name bound to document.getElementById(...) */
	function goPlain() {
		var frm = document.getElementById("plainForm");
		frm.action = "<c:url value='/things/plain.do'/>";
		frm.submit();
	}

	/* jQuery writes both halves as method calls */
	function goJquery() {
		$('#listForm').attr('action', "<c:url value='/things/jquery.do'/>");
		$('#listForm').submit();
	}

	/* a form nobody submits from script is the markup's business, not ours */
	function onlyAssigns() {
		document.orphanForm.action = "<c:url value='/things/never.do'/>";
	}

	/* a form this page never declares: the method is not found */
	function goOutside(frm) {
		frm.action = "<c:url value='/things/outside.do'/>";
		frm.submit();
	}

	/* in a page, the address bar is a request */
	function goHome() {
		location.href = "<c:url value='/things/home.do'/>";
	}

	function goReplace(id) {
		location.replace("<c:url value='/things/detail.do'/>?id=" + id);
	}

	/* an address with no path is not a route, so it stays a navigation */
	function reload() {
		location.href = "";
	}
</script>
</head>
<body>
	<form:form modelAttribute="thingVO" id="listForm" name="listForm" method="post">
		<input type="hidden" id="id" name="id" />
	</form:form>
	<form id="plainForm" name="plainForm">
		<input type="text" name="q" />
	</form>
	<form:form modelAttribute="thingVO" name="orphanForm"></form:form>
</body>
</html>
