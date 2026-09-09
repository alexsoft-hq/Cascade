'use strict';

var demoApp = angular.module('demoApp', ['ui.router']);

demoApp.config(['$stateProvider', '$urlRouterProvider', function ($stateProvider, $urlRouterProvider) {
    $urlRouterProvider.otherwise('/things');
    $stateProvider
        .state('shell', {
            abstract: true,
            url: '',
            template: '<ui-view></ui-view>'
        })
        .state('things', {
            parent: 'shell',
            url: '/things',
            template: '<thing-list></thing-list>'
        })
        .state('shell.ghost', {
            url: '/ghost',
            template: '<never-registered></never-registered>'
        })
        .state('twins', {
            parent: 'shell',
            url: '/twins',
            component: 'twin'
        })
        .state('boxes', {
            parent: 'shell',
            url: '/boxes',
            template: '<widget-box></widget-box>'
        });
}]);
