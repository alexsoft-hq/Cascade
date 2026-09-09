'use strict';

angular.module('legacy', ['ngRoute'])
    .config(['$routeProvider', function ($routeProvider) {
        $routeProvider
            .when('/legacy', {
                templateUrl: 'scripts/legacy/legacy.template.html',
                controller: 'LegacyController'
            })
            .otherwise({ redirectTo: '/things' });
    }])
    .controller('LegacyController', ['$http', function ($http) {
        $http.get('api/shop/legacy/items');
    }]);
