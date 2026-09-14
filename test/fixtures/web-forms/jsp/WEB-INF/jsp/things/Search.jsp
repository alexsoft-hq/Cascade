<%@ page contentType="text/html; charset=utf-8"%>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<%@ taglib prefix="form" uri="http://www.springframework.org/tags/form"%>
<%@ taglib prefix="spring" uri="http://www.springframework.org/tags"%>
<html>
<head>
<script type="text/javascript">
	/* a JSP tag with double quotes inside a double-quoted string */
	var pagetitle = "<spring:message code="comCmm.unitContent.20"/>";
	/* a JSP tag breaking single quotes */
	var calendar = { buttonImage: '<c:url value='/images/egovframework/com/cmm/icon/bu_icon_carlendar.gif'/>' };

	/* the pagination function assigns an address and submits */
	function linkPage(pageNo) {
		document.listForm.pageIndex.value = pageNo;
		document.listForm.action = "<c:url value='/things/list.do'/>";
		document.listForm.submit();
	}

	/* the search function only submits: it sends the form element's action */
	function fnSearch() {
		document.listForm.pageIndex.value = 1;
		document.listForm.submit();
	}

	/* a form this page never declares, and no action anywhere in scope */
	function fnNowhere() {
		document.ghostForm.submit();
	}

	/* two functions with one name are two scopes */
	function fnDup() {
		document.listForm.action = "<c:url value='/things/dup.do'/>";
		document.listForm.submit();
	}
	function fnDup() {
		document.listForm.submit();
	}

<c:if test="${not empty searchVO}">
	fnSearch();
</c:if>
</script>
<script type="text/javascript">
	document.listForm.action = "<c:url value='/things/module.do'/>";
	document.listForm.submit();
</script>
</head>
<body>
	<form:form modelAttribute="searchVO" name="listForm" method="post" action="${pageContext.request.contextPath}/things/search.do">
		<input type="hidden" name="pageIndex" />
	</form:form>
</body>
</html>
