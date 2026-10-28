namespace sales;
 
entity Customers {
key ID : UUID;
CustomerID : String(10);
Name : String(100);
Email : String(100);
City : String(100);
Country : String(100)
}
 
entity Products {
key ID : UUID;
ProductID : String(10);
Name : String(100);
Price : Decimal(15,2);
Category : String(100);
}
 
entity SalesOrders {
key ID : UUID;
OrderNo : String(20);
OrderDate : Date;
Status : String(20);
 
customer : Association to Customers;
 
items : Composition of many SalesOrderItems
on items.parent = $self;
}
 
entity SalesOrderItems {
key ID : UUID;
 
parent : Association to SalesOrders;
 
product : Association to Products;
 
Quantity : Integer;
UnitPrice : Decimal(15,2);
Amount : Decimal(15,2);
}