'use strict';

angular.module('thingBadge', [])
    .component('thingBadge', {
        template: '<span class="badge">{{$ctrl.label}}</span>',
        controller: 'ThingBadgeController'
    })
    .controller('ThingBadgeController', ['$http', function ($http) {
        var self = this;
        $http.get('/api/shop/badges').then(function (resp) {
            self.label = resp.data.label;
        });
    }]);
