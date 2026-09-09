<#macro head>
<link rel="stylesheet" href="${request.contextPath}/static/vendor/table.css">
<script src="${request.contextPath}/static/vendor/jquery.js"></script>
<script>
	// the app root, once, for every page that imports this file
	var base_url = '${request.contextPath}';
	var I18n = ${i18n.all()};
</script>
</#macro>
