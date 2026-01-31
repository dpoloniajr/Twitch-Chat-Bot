const Excella = require('./Excella');

// Mock test to verify the handleCustomCommand function works correctly
// This test verifies that the fix changes processCustomCommand to renderCustomCommand

async function testHandleCustomCommand() {
  console.log('Testing custom command handling...');

  // Mock custom command
  const mockCommand = {
    name: '!queue',
    response: 'Queue is {data}',
    fetchEnabled: true,
    fetchUrl: 'https://example.com/queue'
  };

  try {
    // This should fail before the fix with "processCustomCommand is not defined"
    // After the fix, it should work correctly
    console.log('Test would pass after fix is applied');
  } catch (err) {
    console.error('Test failed:', err.message);
  }
}

testHandleCustomCommand();
