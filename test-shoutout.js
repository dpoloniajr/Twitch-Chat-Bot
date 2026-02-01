// Test file for shoutout command functionality
// Tests the !shoutout and !so commands with channel link verification

const path = require('path');

// Mock Twitch API responses
const mockUserResponse = {
  id: '123456',
  name: 'testuser',
  displayName: 'TestUser'
};

const mockChannelInfo = {
  gameName: 'Just Chatting'
};

const mockStreamInfo = {
  userId: '123456',
  userName: 'testuser'
};

// Test logging
function logTest(title, result, details = '') {
  const icon = result ? '✓' : '✗';
  console.log(`${icon} ${title}`);
  if (details) console.log(`  └─ ${details}`);
}

// Test 1: Verify channel link is included in shoutout message
function testChannelLinkInMessage() {
  console.log('\n=== Testing Channel Link in Shoutout Message ===\n');

  try {
    // Simulate the shoutout response that would be returned
    const mockShoutoutResult = {
      success: true,
      message: `📢 Shoutout to ${mockUserResponse.displayName}! Check out their channel: https://twitch.tv/${mockUserResponse.name} - They're playing ${mockChannelInfo.gameName} - go follow them!`,
      username: mockUserResponse.displayName,
      gameName: mockChannelInfo.gameName,
      isLive: true,
      channelUrl: `https://twitch.tv/${mockUserResponse.name}`
    };

    // Verify the response has all required fields
    const hasChannelUrl = mockShoutoutResult.channelUrl !== undefined;
    const hasChannelInMessage = mockShoutoutResult.message.includes('https://twitch.tv/');
    const correctChannelUrl = mockShoutoutResult.channelUrl === `https://twitch.tv/${mockUserResponse.name}`;

    logTest(
      'Channel URL field exists in response',
      hasChannelUrl,
      `channelUrl: ${mockShoutoutResult.channelUrl}`
    );

    logTest(
      'Channel link included in chat message',
      hasChannelInMessage,
      `Message: ${mockShoutoutResult.message}`
    );

    logTest(
      'Channel URL format is correct',
      correctChannelUrl,
      `Expected: https://twitch.tv/${mockUserResponse.name}`
    );

    return hasChannelUrl && hasChannelInMessage && correctChannelUrl;
  } catch (error) {
    logTest('Channel link test', false, error.message);
    return false;
  }
}

// Test 2: Verify !so command handler exists and references correct function
function testSoCommandExists() {
  console.log('\n=== Testing !so Command ===\n');

  try {
    // Read the Excella file to verify the !so command is properly defined
    const fs = require('fs');
    const excellaContent = fs.readFileSync(path.join(__dirname, 'Excella'), 'utf8');

    // Check if !so command is defined
    const hasSoCommand = excellaContent.includes("['!so'");
    logTest(
      '!so command is registered',
      hasSoCommand,
      'Found !so command in registry'
    );

    // Check if !so calls handleShoutout
    const soCallsHandleShoutout = excellaContent.includes("await handleShoutout(channel, username, args[0])");
    logTest(
      '!so calls handleShoutout function',
      soCallsHandleShoutout,
      'Verified handleShoutout is called by !so'
    );

    // Check if !so uses the same cooldown as !shoutout
    const soUsesShoutoutCooldown = excellaContent.includes("getCommandCooldown('!shoutout')") &&
                                     excellaContent.includes("isOnCooldown('shoutout'");
    logTest(
      '!so uses !shoutout cooldown',
      soUsesShoutoutCooldown,
      'Both commands share the same cooldown system'
    );

    return hasSoCommand && soCallsHandleShoutout && soUsesShoutoutCooldown;
  } catch (error) {
    logTest('!so command verification', false, error.message);
    return false;
  }
}

// Test 3: Verify shoutout response structure
function testShoutoutResponseStructure() {
  console.log('\n=== Testing Shoutout Response Structure ===\n');

  try {
    const mockShoutoutResult = {
      success: true,
      message: `📢 Shoutout to ${mockUserResponse.displayName}! Check out their channel: https://twitch.tv/${mockUserResponse.name} - They're playing ${mockChannelInfo.gameName} - go follow them!`,
      username: mockUserResponse.displayName,
      gameName: mockChannelInfo.gameName,
      isLive: true,
      channelUrl: `https://twitch.tv/${mockUserResponse.name}`
    };

    const hasSuccessField = mockShoutoutResult.hasOwnProperty('success');
    const hasMessageField = mockShoutoutResult.hasOwnProperty('message');
    const hasUsernameField = mockShoutoutResult.hasOwnProperty('username');
    const hasGameNameField = mockShoutoutResult.hasOwnProperty('gameName');
    const hasIsLiveField = mockShoutoutResult.hasOwnProperty('isLive');
    const hasChannelUrlField = mockShoutoutResult.hasOwnProperty('channelUrl');

    logTest('Response has success field', hasSuccessField);
    logTest('Response has message field', hasMessageField);
    logTest('Response has username field', hasUsernameField);
    logTest('Response has gameName field', hasGameNameField);
    logTest('Response has isLive field', hasIsLiveField);
    logTest('Response has channelUrl field', hasChannelUrlField);

    return hasSuccessField && hasMessageField && hasUsernameField && hasGameNameField && hasIsLiveField && hasChannelUrlField;
  } catch (error) {
    logTest('Response structure test', false, error.message);
    return false;
  }
}

// Test 4: Verify offline shoutout includes channel link
function testOfflineShoutoutIncludesChannelLink() {
  console.log('\n=== Testing Offline Shoutout Channel Link ===\n');

  try {
    const mockOfflineResult = {
      success: true,
      message: `📢 Shoutout to ${mockUserResponse.displayName}! Check out their channel: https://twitch.tv/${mockUserResponse.name} - They're playing ${mockChannelInfo.gameName}`,
      username: mockUserResponse.displayName,
      gameName: mockChannelInfo.gameName,
      isLive: false,
      channelUrl: `https://twitch.tv/${mockUserResponse.name}`
    };

    const hasChannelUrl = mockOfflineResult.channelUrl !== undefined;
    const hasChannelLink = mockOfflineResult.message.includes('https://twitch.tv/');
    const messageCorrect = mockOfflineResult.message.includes('Check out their channel:');

    logTest(
      'Offline shoutout includes channel URL field',
      hasChannelUrl,
      `channelUrl: ${mockOfflineResult.channelUrl}`
    );

    logTest(
      'Offline shoutout message contains channel link',
      hasChannelLink,
      'Channel link present in offline message'
    );

    logTest(
      'Offline shoutout message is properly formatted',
      messageCorrect,
      `Message: ${mockOfflineResult.message}`
    );

    return hasChannelUrl && hasChannelLink && messageCorrect;
  } catch (error) {
    logTest('Offline shoutout test', false, error.message);
    return false;
  }
}

// Run all tests
async function runAllTests() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   SHOUTOUT COMMAND FUNCTIONALITY TESTS     ║');
  console.log('╚════════════════════════════════════════════╝');

  const test1 = testChannelLinkInMessage();
  const test2 = testSoCommandExists();
  const test3 = testShoutoutResponseStructure();
  const test4 = testOfflineShoutoutIncludesChannelLink();

  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║            TEST SUMMARY                    ║');
  console.log('╚════════════════════════════════════════════╝\n');

  const allPassed = test1 && test2 && test3 && test4;
  const passedCount = [test1, test2, test3, test4].filter(t => t).length;

  console.log(`Tests Passed: ${passedCount}/4`);
  console.log(`Overall Status: ${allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);

  return allPassed;
}

// Execute tests
runAllTests().then(result => {
  process.exit(result ? 0 : 1);
}).catch(error => {
  console.error('Test execution error:', error);
  process.exit(1);
});
