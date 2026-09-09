'use strict';

angular.module('twinA', [])
    .component('twin', { controller: 'TwinAController' })
    .controller('TwinAController', ['$http', function ($http) {
        $http.get('api/shop/twins/a');
    }]);
