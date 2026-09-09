<%@ include file="../common/Top.jsp"%>

<div id="BackLink"><a href="${pageContext.request.contextPath}/catalog">Return to Main Menu</a></div>

<form method="post" action="${pageContext.request.contextPath}/cart/update">
  <c:forEach var="cartItem" items="${cart.cartItemList}">
    <a href="${pageContext.request.contextPath}/cart/removeItem?workingItemId=${cartItem.item.itemId}">Remove</a>
  </c:forEach>
  <input type="submit" name="updateCartQuantities" value="Update Cart" />
</form>

<a class="Button" href="<c:url value='/order/new'/>">Proceed to Checkout</a>
<a href="${pageContext.request.contextPath}/images/cart.gif">an image, not a route</a>

<%@ include file="../common/Bottom.jsp"%>
