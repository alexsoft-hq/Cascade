'use strict';

angular.module('widget', [])
    .directive('widgetBox', function () {
        return {
            restrict: 'E',
            templateUrl: 'scripts/widget/widget.template.html',
            controller: 'WidgetController'
        };
    })
    .directive('widgetHighlight', function () {
        return { restrict: 'A' };
    })
    .controller('WidgetController', function ($http) {
        this.load = function () { return $http.get('api/shop/widgets'); };
    });
