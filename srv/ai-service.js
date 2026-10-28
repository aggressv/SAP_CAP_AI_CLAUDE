
import cds from '@sap/cds';
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const { SELECT, INSERT } = cds.ql;

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const MAX_STEPS = 6;
const MAX_ROWS = 100;
const MAX_TOKENS = 2048;

const CREATE_ROLE = process.env.AI_CREATE_ROLE || '';
const PRODUCT_CREATE_ROLE = process.env.AI_PRODUCT_CREATE_ROLE || '';

const ENTITIES = {
  Customers: 'sales.Customers',
  Products: 'sales.Products',
  SalesOrders: 'sales.SalesOrders'
};

const entityNames = Object.keys(ENTITIES);

const SYSTEM_PROMPT = `
You are an AI assistant for an SAP Sales application backed by SAP HANA.

Use the tools to read real database information and create records only
when the user explicitly requests creation.

Rules:
- Never invent database records or missing required values.
- Customer creation requires Name and Email.
- Product creation requires ProductID, Name, Price and Category.
- Never claim success unless the database operation succeeds.
- Ask the user for missing required values.
- Do not claim sales-order creation is supported.
- Explain errors clearly.
`;

// Initialize lazily so the server can report a clear configuration error.
let anthropic;

function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }

  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  return anthropic;
}

// --------------------------------------------------
// Claude tool definitions
// --------------------------------------------------

const tools = [
  {
    name: 'describe',
    description: 'Describe the fields in a supported sales entity.',
    input_schema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: entityNames }
      },
      required: ['entity']
    }
  },
  {
    name: 'list_records',
    description: 'List records with optional equality filters.',
    input_schema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: entityNames },
        fields: { type: 'array', items: { type: 'string' } },
        filters: { type: 'object' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS }
      },
      required: ['entity']
    }
  },
  {
    name: 'count_records',
    description: 'Count records with optional equality filters.',
    input_schema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: entityNames },
        filters: { type: 'object' }
      },
      required: ['entity']
    }
  },
  {
    name: 'aggregate',
    description: 'Aggregate numeric data using count, sum, avg, min or max.',
    input_schema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: entityNames },
        operation: {
          type: 'string',
          enum: ['count', 'sum', 'avg', 'min', 'max']
        },
        field: { type: 'string' },
        filters: { type: 'object' }
      },
      required: ['entity', 'operation']
    }
  },
  {
    name: 'create_customer',
    description: 'Create one customer. Name and Email are required.',
    input_schema: {
      type: 'object',
      properties: {
        CustomerID: { type: 'string' },
        Name: { type: 'string' },
        Email: { type: 'string' },
        City: { type: 'string' },
        Country: { type: 'string' }
      },
      required: ['Name', 'Email']
    }
  },
  {
    name: 'create_product',
    description:
      'Create one product. ProductID, Name, Price and Category are required. ' +
      'Do not invent missing values.',
    input_schema: {
      type: 'object',
      properties: {
        ProductID: {
          type: 'string',
          description: 'Unique product ID, maximum 10 characters.'
        },
        Name: {
          type: 'string',
          description: 'Product name, maximum 100 characters.'
        },
        Price: {
          type: 'number',
          description: 'Non-negative price with at most two decimal places.'
        },
        Category: {
          type: 'string',
          description: 'Product category, maximum 100 characters.'
        }
      },
      required: ['ProductID', 'Name', 'Price', 'Category']
    }
  }
];

// --------------------------------------------------
// Entity and field helpers
// --------------------------------------------------

function resolve(entity) {
  if (typeof entity !== 'string') {
    throw new Error('Entity must be a string.');
  }

  const name = entityNames.find(
    item => item.toLowerCase() === entity.trim().toLowerCase()
  );

  if (!name) {
    throw new Error(
      `Unsupported entity "${entity}". Supported entities: ${entityNames.join(', ')}.`
    );
  }

  return { name, target: ENTITIES[name] };
}

function getDefinition(entity) {
  const { target } = resolve(entity);
  const definition = cds.model.definitions[target];

  if (!definition) {
    throw new Error(`CDS entity definition "${target}" was not found.`);
  }

  return definition;
}

function isAssociation(element) {
  return Boolean(
    element.isAssociation ||
    element.isComposition ||
    element.target ||
    element.type === 'cds.Association' ||
    element.type === 'cds.Composition'
  );
}

function getFields(entity) {
  return Object.entries(getDefinition(entity).elements || {})
    .filter(([, element]) => !isAssociation(element))
    .map(([name, element]) => ({
      name,
      type: element.type || 'unknown',
      key: Boolean(element.key),
      notNull: Boolean(element.notNull)
    }));
}

function getFieldNames(entity) {
  return getFields(entity).map(field => field.name);
}

function normalizeFieldName(entity, suppliedName) {
  if (typeof suppliedName !== 'string') {
    throw new Error('Field names must be strings.');
  }

  const actual = getFieldNames(entity).find(
    name => name.toLowerCase() === suppliedName.trim().toLowerCase()
  );

  if (!actual) {
    throw new Error(
      `Unknown field "${suppliedName}" for ${entity}. ` +
      `Available fields: ${getFieldNames(entity).join(', ')}.`
    );
  }

  return actual;
}

function normalizeFilters(entity, filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new Error('Filters must be an object.');
  }

  const result = {};

  for (const [field, value] of Object.entries(filters)) {
    if (value === undefined) {
      throw new Error(`Filter "${field}" cannot be undefined.`);
    }

    result[normalizeFieldName(entity, field)] = value;
  }

  return result;
}

function checkRole(req, role) {
  if (role && !req.user?.is?.(role)) {
    throw new Error(`You are not authorized to perform this operation. Required role: ${role}.`);
  }
}

// --------------------------------------------------
// Read operations
// --------------------------------------------------

async function describeEntity({ entity }) {
  const resolved = resolve(entity);

  return {
    entity: resolved.name,
    databaseEntity: resolved.target,
    fields: getFields(resolved.name)
  };
}

async function listRecords(tx, { entity, fields, filters, limit }) {
  const resolved = resolve(entity);

  const selectedFields = Array.isArray(fields) && fields.length
    ? [...new Set(fields.map(field => normalizeFieldName(resolved.name, field)))]
    : getFieldNames(resolved.name);

  const query = SELECT.from(resolved.target).columns(...selectedFields);
  const where = normalizeFilters(resolved.name, filters || {});

  if (Object.keys(where).length) query.where(where);

  const rowLimit = Math.min(
    Math.max(Number.isInteger(limit) ? limit : 20, 1),
    MAX_ROWS
  );

  query.limit(rowLimit);

  const records = await tx.run(query);

  return {
    entity: resolved.name,
    count: records.length,
    records
  };
}

async function countRecords(tx, { entity, filters }) {
  const resolved = resolve(entity);
  const query = SELECT.from(resolved.target).columns({
    func: 'count',
    args: [{ val: 1 }],
    as: 'total'
  });

  const where = normalizeFilters(resolved.name, filters || {});
  if (Object.keys(where).length) query.where(where);

  const rows = await tx.run(query);

  return {
    entity: resolved.name,
    count: Number(rows?.[0]?.total ?? 0)
  };
}

async function aggregateRecords(tx, { entity, operation, field, filters }) {
  const resolved = resolve(entity);
  const supported = ['count', 'sum', 'avg', 'min', 'max'];

  if (!supported.includes(operation)) {
    throw new Error(`Unsupported aggregate operation "${operation}".`);
  }

  const query = SELECT.from(resolved.target);

  if (operation === 'count') {
    query.columns({
      func: 'count',
      args: [{ val: 1 }],
      as: 'result'
    });
  } else {
    if (!field) throw new Error(`Field is required for ${operation}.`);

    const actualField = normalizeFieldName(resolved.name, field);
    const element = getDefinition(resolved.name).elements[actualField];

    const numericTypes = [
      'cds.Integer', 'cds.Integer64', 'cds.Decimal',
      'cds.DecimalFloat', 'cds.Double', 'cds.Float',
      'cds.Int16', 'cds.Int32', 'cds.Int64'
    ];

    if (!numericTypes.includes(element.type)) {
      throw new Error(`"${actualField}" is not a numeric field.`);
    }

    query.columns({
      func: operation,
      args: [{ ref: [actualField] }],
      as: 'result'
    });
  }

  const where = normalizeFilters(resolved.name, filters || {});
  if (Object.keys(where).length) query.where(where);

  const rows = await tx.run(query);

  return {
    entity: resolved.name,
    operation,
    field: field || null,
    result: rows?.[0]?.result ?? 0
  };
}

// --------------------------------------------------
// Customer creation
// --------------------------------------------------

async function createCustomerRecord(tx, req, data) {
  checkRole(req, CREATE_ROLE);

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Customer data must be an object.');
  }

  const allowed = ['CustomerID', 'Name', 'Email', 'City', 'Country'];
  const unknown = Object.keys(data).filter(key => !allowed.includes(key));

  if (unknown.length) {
    throw new Error(`Unsupported customer fields: ${unknown.join(', ')}.`);
  }

  const CustomerID = typeof data.CustomerID === 'string' ? data.CustomerID.trim() : '';
  const Name = typeof data.Name === 'string' ? data.Name.trim() : '';
  const Email = typeof data.Email === 'string' ? data.Email.trim() : '';
  const City = typeof data.City === 'string' ? data.City.trim() : '';
  const Country = typeof data.Country === 'string' ? data.Country.trim() : '';

  if (!Name || Name.length > 100) {
    throw new Error('Name is required and must not exceed 100 characters.');
  }

  if (!Email || Email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(Email)) {
    throw new Error('A valid Email is required (maximum 100 characters).');
  }

  if (CustomerID.length > 10) {
    throw new Error('CustomerID must not exceed 10 characters.');
  }

  if (City.length > 100 || Country.length > 100) {
    throw new Error('City and Country must not exceed 100 characters.');
  }

  const target = ENTITIES.Customers;

  if (await tx.run(SELECT.one.from(target).where({ Email }))) {
    throw new Error(`A customer with email "${Email}" already exists.`);
  }

  if (CustomerID && await tx.run(SELECT.one.from(target).where({ CustomerID }))) {
    throw new Error(`CustomerID "${CustomerID}" already exists.`);
  }

  const customer = {
    ID: cds.utils.uuid(),
    Name,
    Email,
    ...(CustomerID ? { CustomerID } : {}),
    ...(City ? { City } : {}),
    ...(Country ? { Country } : {})
  };

  await tx.run(INSERT.into(target).entries(customer));

  console.log(`[AI] Customer created: ${CustomerID || Email}`);

  return { created: true, customer };
}

// --------------------------------------------------
// Product creation, including Category
// --------------------------------------------------

async function createProductRecord(tx, req, data) {
  checkRole(req, PRODUCT_CREATE_ROLE);

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Product data must be an object.');
  }

  const allowed = ['ProductID', 'Name', 'Price', 'Category'];
  const unknown = Object.keys(data).filter(key => !allowed.includes(key));

  if (unknown.length) {
    throw new Error(`Unsupported product fields: ${unknown.join(', ')}.`);
  }

  const ProductID = typeof data.ProductID === 'string' ? data.ProductID.trim() : '';
  const Name = typeof data.Name === 'string' ? data.Name.trim() : '';
  const Category = typeof data.Category === 'string' ? data.Category.trim() : '';

  // OData Decimal parameters may arrive as strings.
  const priceText = String(data.Price ?? '');

  if (!ProductID || ProductID.length > 10) {
    throw new Error('ProductID is required and must not exceed 10 characters.');
  }

  if (!Name || Name.length > 100) {
    throw new Error('Name is required and must not exceed 100 characters.');
  }

  if (!Category || Category.length > 100) {
    throw new Error('Category is required and must not exceed 100 characters.');
  }

  if (!/^\d+(\.\d{1,2})?$/.test(priceText)) {
    throw new Error('Price must be non-negative with at most two decimal places.');
  }

  const Price = Number(priceText);

  if (!Number.isFinite(Price) || Price > 9999999999999.99) {
    throw new Error('Price is outside the supported range.');
  }

  const target = ENTITIES.Products;
  const existing = await tx.run(
    SELECT.one.from(target).where({ ProductID })
  );

  if (existing) {
    throw new Error(`ProductID "${ProductID}" already exists. No product was created.`);
  }

  const product = {
    ID: cds.utils.uuid(),
    ProductID,
    Name,
    Price: Price.toFixed(2),
    Category
  };

  await tx.run(INSERT.into(target).entries(product));

  console.log(`[AI] Product created: ${ProductID}`);

  return { created: true, product };
}

// --------------------------------------------------
// Claude tool dispatch
// --------------------------------------------------

function makeHandlers(tx, req) {
  return {
    describe: input => describeEntity(input),
    list_records: input => listRecords(tx, input),
    count_records: input => countRecords(tx, input),
    aggregate: input => aggregateRecords(tx, input),
    create_customer: input => createCustomerRecord(tx, req, input),
    create_product: input => createProductRecord(tx, req, input)
  };
}

// --------------------------------------------------
// AIService implementation
// --------------------------------------------------

export default cds.service.impl(function () {
  this.on('AskAI', async req => {
    const prompt = req.data?.prompt;

    if (typeof prompt !== 'string' || !prompt.trim()) {
      return req.reject(400, 'Please provide a prompt.');
    }

    let client;

    try {
      client = getAnthropic();
    } catch (error) {
      return req.reject(500, error.message);
    }

    const tx = cds.tx(req);
    const handlers = makeHandlers(tx, req);

    const messages = [
      { role: 'user', content: prompt.trim() }
    ];

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools,
          messages
        });

        messages.push({
          role: 'assistant',
          content: response.content
        });

        const toolCalls = response.content.filter(
          block => block.type === 'tool_use'
        );

        if (!toolCalls.length) {
          return response.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n')
            .trim() || 'The AI assistant returned no text.';
        }

        const toolResults = [];

        for (const toolCall of toolCalls) {
          const handler = handlers[toolCall.name];

          if (!handler) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              is_error: true,
              content: `Unknown tool: ${toolCall.name}`
            });
            continue;
          }

          try {
            const result = await handler(toolCall.input || {});

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: JSON.stringify(result)
            });
          } catch (error) {
            console.error(`[AI] ${toolCall.name} failed:`, error.message);

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              is_error: true,
              content: error.message || 'Tool operation failed.'
            });
          }
        }

        messages.push({
          role: 'user',
          content: toolResults
        });
      }

      return 'Maximum AI tool steps reached. Please try a more specific request.';
    } catch (error) {
      console.error('[AI] AskAI failed:', error);
      return req.reject(502, 'AI request failed. Check the Claude API configuration and server logs.');
    }
  });

  // Direct OData action: createCustomer
  this.on('createCustomer', async req => {
    try {
      const tx = cds.tx(req);
      const customer = await createCustomerRecord(tx, req, req.data);
      return JSON.stringify(customer);
    } catch (error) {
      console.error('[AIService] createCustomer failed:', error);
      return req.reject(
        error.message.includes('already exists') ? 409 : 400,
        error.message
      );
    }
  });

  // Direct OData action: createProduct
  this.on('createProduct', async req => {
    try {
      const tx = cds.tx(req);
      const product = await createProductRecord(tx, req, req.data);
      return JSON.stringify(product);
    } catch (error) {
      console.error('[AIService] createProduct failed:', error);
      return req.reject(
        error.message.includes('already exists') ? 409 : 400,
        error.message
      );
    }
  });
});
