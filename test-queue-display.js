/**
 * Test script for queue display commands
 * Tests the !song, !currentsong, and !queue commands
 */

const axios = require('axios');

const DASHBOARD_URL = 'http://localhost:3001';

// Mock song data for testing
const mockSongs = [
  {
    videoId: 'dQw4w9WgXcQ',
    title: 'Rick Astley - Never Gonna Give You Up',
    channelTitle: 'Rick Astley',
    channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
    durationSeconds: 213,
    durationFormatted: '3:33',
    thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg',
    requester: 'testuser1',
    requesterDisplayName: 'TestUser1',
    requesterIsSub: false,
    requesterIsVip: false,
    requesterIsMod: false,
    requesterIsBroadcaster: false
  },
  {
    videoId: 'ZZ5LpwO-An4',
    title: 'HEYYEYAAEYAAAEYAEYAA',
    channelTitle: 'ProtoOfSnagem',
    channelId: 'UCGm6JpvS3mFgU1gGY87NOYw',
    durationSeconds: 172,
    durationFormatted: '2:52',
    thumbnail: 'https://i.ytimg.com/vi/ZZ5LpwO-An4/default.jpg',
    requester: 'testuser2',
    requesterDisplayName: 'TestUser2',
    requesterIsSub: true,
    requesterIsVip: false,
    requesterIsMod: false,
    requesterIsBroadcaster: false
  },
  {
    videoId: 'y6120QOlsfU',
    title: 'Darude - Sandstorm',
    channelTitle: 'DarudeDJOfficial',
    channelId: 'UCT85K8wBVfUB5F6cEKa4s1A',
    durationSeconds: 215,
    durationFormatted: '3:35',
    thumbnail: 'https://i.ytimg.com/vi/y6120QOlsfU/default.jpg',
    requester: 'testuser3',
    requesterDisplayName: 'TestUser3',
    requesterIsSub: false,
    requesterIsVip: true,
    requesterIsMod: false,
    requesterIsBroadcaster: false
  }
];

async function testQueueDisplay() {
  console.log('=== Testing Queue Display Commands ===\n');

  try {
    // Clear queue before tests to ensure deterministic state
    console.log('Setup: Clearing queue before tests...');
    try {
      await axios.post(`${DASHBOARD_URL}/api/song-queue/clear`);
      console.log('✓ Queue cleared\n');
    } catch (err) {
      console.log('Note: Could not clear queue:', err.message, '\n');
    }

    // Test 1: Get empty queue
    console.log('Test 1: Fetching empty queue...');
    let response = await axios.get(`${DASHBOARD_URL}/api/song-queue`);
    console.log('Response:', JSON.stringify(response.data, null, 2));

    if (response.data.active.length === 0) {
      console.log('✓ Empty queue test PASSED\n');
    } else {
      console.log('✗ Empty queue test FAILED - queue not empty\n');
    }

    // Test 2: Add songs to queue
    console.log('Test 2: Adding songs to queue...');
    for (const song of mockSongs) {
      try {
        const addResponse = await axios.post(`${DASHBOARD_URL}/api/song-queue/add`, song);
        console.log(`✓ Added: "${song.title}" at position ${addResponse.data.position}`);
      } catch (error) {
        console.log(`✗ Failed to add "${song.title}":`, error.response?.data?.error || error.message);
      }
    }
    console.log();

    // Test 3: Get queue with songs
    console.log('Test 3: Fetching queue with songs...');
    response = await axios.get(`${DASHBOARD_URL}/api/song-queue`);
    console.log('Queue data:', JSON.stringify(response.data, null, 2));

    const queue = response.data.active;
    console.log(`\nQueue has ${queue.length} songs\n`);

    // Test 4: Simulate !song command output
    console.log('Test 4: Simulating !song command...');
    if (queue.length === 0) {
      console.log('Chat output: No songs in the queue.');
    } else {
      const current = queue[0];
      let message = `Now playing: "${current.title}" by ${current.channelTitle} [${current.durationFormatted}] (requested by @${current.requester})`;

      if (queue.length > 1) {
        const next = queue[1];
        message += ` | Next up: "${next.title}" [${next.durationFormatted}]`;
      }

      console.log('Chat output:', message);
    }
    console.log();

    // Test 5: Simulate !queue command output
    console.log('Test 5: Simulating !queue command...');
    if (queue.length === 0) {
      console.log('Chat output: The queue is empty. Use !sr <URL or search query> to add a song!');
    } else {
      const totalSeconds = queue.reduce((sum, song) => sum + song.durationSeconds, 0);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;

      let totalFormatted = '';
      if (hours > 0) {
        totalFormatted = `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
      } else {
        totalFormatted = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      }

      const count = queue.length;
      let message = `Queue: ${count} song${count !== 1 ? 's' : ''} (${totalFormatted} total)`;

      // slice(1, 4) skips index 0 (currently playing) to show the next 3 songs
      const nextSongs = queue.slice(1, 4);
      if (nextSongs.length > 0) {
        message += ' | Up next: ';
        const songList = nextSongs.map((song, idx) =>
          `${idx + 2}. "${song.title}" [${song.durationFormatted}]`
        ).join(', ');
        message += songList;
      }

      console.log('Chat output:', message);
    }
    console.log();

    // Test 6: Clear queue for cleanup
    console.log('Test 6: Cleaning up - clearing queue...');
    try {
      await axios.post(`${DASHBOARD_URL}/api/song-queue/clear`);
      console.log('✓ Queue cleared successfully\n');
    } catch (error) {
      if (error.response?.status === 404) {
        console.log('⚠ Clear endpoint not yet implemented (Phase 4). Skipping cleanup.\n');
        console.log('Note: You can manually clear the queue from dashboard/logs/song-queue.json\n');
      } else {
        console.log('✗ Failed to clear queue:', error.response?.data?.error || error.message);
      }
    }

    console.log('=== All tests completed ===');

  } catch (error) {
    console.error('Error during testing:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('\nMake sure the dashboard server is running on port 3001!');
      console.error('Run: npm run dashboard');
    }
  }
}

// Run tests
testQueueDisplay();
