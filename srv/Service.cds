using sales from '../db/schema';
service SalesService {
    @odata.draft.enabled
    entity Customers as projection on sales.Customers;
    
    @odata.draft.enabled
    entity Products as projection on sales.Products;

    @odata.draft.enabled
    entity SalesOrders as projection on sales.SalesOrders;

    entity SalesOrderItems as projection on sales.SalesOrderItems;
        // AI Action integrated into the Sales Service
    //action AskAI(prompt : String) returns String;
    
}