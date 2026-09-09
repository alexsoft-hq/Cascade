<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<html>
<body>
<div id="Header">
  <a href="${pageContext.request.contextPath}/catalog">Home</a>
  <form action="${pageContext.request.contextPath}/catalog/searchProducts" method="post">
    <input type="text" name="keyword" />
    <input type="submit" name="searchProducts" value="Search" />
  </form>
</div>
