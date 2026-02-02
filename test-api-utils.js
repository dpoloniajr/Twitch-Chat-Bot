/**
 * Unit tests for lib/api-utils.js
 */
const { validateRequest, ValidationError } = require('./lib/api-utils');

console.log('🧪 Testing API Utils...\n');

// Mock Express req, res, next
const mockRes = {
  status: function(code) {
    this.statusCode = code;
    return this;
  },
  json: function(data) {
    this.data = data;
    return this;
  }
};

function runTest(name, schema, body, expectedError) {
  process.stdout.write(`- ${name}: `);
  const req = { body };
  let nextCalled = false;
  let errorCaught = null;

  const middleware = validateRequest(schema);
  
  middleware(req, mockRes, (err) => {
    nextCalled = true;
    errorCaught = err;
  });

  if (expectedError) {
    if (errorCaught instanceof ValidationError && errorCaught.message === expectedError) {
      console.log('✓ Pass');
    } else {
      console.log(`✗ Fail (Expected error: "${expectedError}", got: "${errorCaught ? errorCaught.message : 'none'}")`);
    }
  } else {
    if (nextCalled && !errorCaught) {
      console.log('✓ Pass');
    } else {
      console.log(`✗ Fail (Expected success, got error: "${errorCaught ? errorCaught.message : 'none'}")`);
    }
  }
}

// 1. Happy Path
runTest('Happy Path', 
  { name: { required: true, type: 'string' }, age: { type: 'number', min: 18 } },
  { name: 'John', age: 25 },
  null
);

// 2. Missing required field
runTest('Missing Required Field',
  { name: { required: true } },
  {},
  'name is required'
);

// 3. Wrong type
runTest('Wrong Type (String expected)',
  { name: { type: 'string' } },
  { name: 123 },
  'name must be a string'
);

// 4. Below minimum
runTest('Below Minimum',
  { age: { type: 'number', min: 18 } },
  { age: 17 },
  'age must be at least 18'
);

// 5. Above maximum
runTest('Above Maximum',
  { score: { type: 'number', max: 100 } },
  { score: 101 },
  'score must be at most 100'
);

// 6. Optional field missing (Success)
runTest('Optional Field Missing',
  { name: { required: true }, age: { required: false } },
  { name: 'John' },
  null
);

console.log('\n✅ API Utils tests completed!');
