'use strict';

angular.module('thingList')
    .controller('ThingListController', ['$http', function ($http) {
        var self = this;

        $http.get('api/shop/things').then(function (resp) {
            self.things = resp.data;
        });

        self.save = function () {
            $http.post('api/shop/things', self.thing);
        };
    }]);
