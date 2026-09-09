'use strict';

angular.module('twinB', [])
    .component('twin', { controller: 'TwinBController' })
    .controller('TwinBController', ['$http', function ($http) {
        $http.get('api/shop/twins/b');
    }]);
