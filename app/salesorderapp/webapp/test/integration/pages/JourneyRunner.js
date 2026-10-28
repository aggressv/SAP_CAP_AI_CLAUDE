sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"salesorders/salesorderapp/test/integration/pages/SalesOrdersList.gen",
	"salesorders/salesorderapp/test/integration/pages/SalesOrdersObjectPage.gen"
], function (JourneyRunner, SalesOrdersListGenerated, SalesOrdersObjectPageGenerated) {
    'use strict';

    const runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('salesorders/salesorderapp') + '/test/flp.html#app-preview',
        pages: {
			onTheSalesOrdersListGenerated: SalesOrdersListGenerated,
			onTheSalesOrdersObjectPageGenerated: SalesOrdersObjectPageGenerated
        },
        async: true
    });

    return runner;
});

