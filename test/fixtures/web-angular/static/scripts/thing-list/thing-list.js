'use strict';

angular.module('thingList', ['ui.router'])
    .config(['$stateProvider', function ($stateProvider) {
        $stateProvider
            .state('thingDetail', {
                parent: 'shell',
                url: '/things/:thingId',
                templateUrl: 'scripts/thing-list/detail.template.html'
            })
    }]);
