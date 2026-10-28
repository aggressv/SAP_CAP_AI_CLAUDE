
service AIService {
    @agent
    action AskAI(prompt: String) returns String;

    action createCustomer(
        CustomerID: String,
        Name: String,
        Email: String,
        City: String,
        Country: String
    ) returns String;

    action createProduct(
        ProductID: String,
        Name: String,
        Price: Decimal(15,2),
        Category: String
    ) returns String;
}

annotate AIService with @agent;
annotate AIService.createCustomer with @agent.hitl;
annotate AIService.createProduct with @agent.hitl;
