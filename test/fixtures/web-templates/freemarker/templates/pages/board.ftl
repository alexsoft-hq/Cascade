<!DOCTYPE html>
<html>
<head>
	<#-- the layout, and the script that names the app root -->
	<#import "../common/macro.ftl" as common>
	<@common.head />
</head>
<body>
<#list rows as row>
	<div>${row.label}</div>
</#list>
<script src="${request.contextPath}/static/vendor/table.js"></script>
<script>
	$.ajax({
		type: 'POST',
		url: base_url + "/board/pageList",
		success: function (data) { render(data); }
	});
	function removeRow(id) {
		$.post(base_url + "/board/remove", { id: id }, function (data) { reload(data); });
	}
	function openLog(id) {
		var url = base_url + '/board/log?id=' + id;
		window.location.href = url;
	}
</script>
</body>
</html>
