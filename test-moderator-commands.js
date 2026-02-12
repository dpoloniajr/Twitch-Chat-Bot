/**
 * Test script for Phase 4 - Moderator Controls
 * Tests the skip, remove, and clear queue functionality
 */

const axios = require('axios');

const DASHBOARD_PORT = 3001;
const BASE_URL = `http://localhost:${DASHBOARD_PORT}/api/song-queue`;

async function testModeratorCommands() {
  console.log('=== Phase 4 - Moderator Controls Test ===\n');

  try {
    // 1. Setup - Add some test songs to the queue
    console.log('1. Setting up test queue with 3 songs...');
    const testSongs = [
      {
        videoId: 'test1',
        title: 'Test Song 1',
        channelTitle: 'Test Channel',
        channelId: 'testchan1',
        durationSeconds: 180,
        durationFormatted: '3:00',
        thumbnail: 'http://example.com/thumb1.jpg',
        requester: 'testuser1',
        requesterDisplayName: 'TestUser1'
      },
      {
        videoId: 'test2',
        title: 'Never Gonna Give You Up',
        channelTitle: 'Rick Astley',
        channelId: 'rickastley',
        durationSeconds: 212,
        durationFormatted: '3:32',
        thumbnail: 'http://example.com/thumb2.jpg',
        requester: 'testuser2',
        requesterDisplayName: 'TestUser2'
      },
      {
        videoId: 'test3',
        title: 'Test Song 3',
        channelTitle: 'Another Channel',
        channelId: 'anotherchan',
        durationSeconds: 240,
        durationFormatted: '4:00',
        thumbnail: 'http://example.com/thumb3.jpg',
        requester: 'testuser1',
        requesterDisplayName: 'TestUser1'
      }
    ];

    for (const song of testSongs) {
      const response = await axios.post(`${BASE_URL}/add`, song);
      if (response.data.success) {
        console.log(`✓ Added: "${song.title}" at position ${response.data.position}`);
      } else {
        console.log(`✗ Failed to add: "${song.title}" - ${response.data.error}`);
      }
    }

    // 2. Test GET /api/song-queue - Verify initial state
    console.log('\n2. Checking initial queue state...');
    let queueResponse = await axios.get(BASE_URL);
    let queue = queueResponse.data.active;
    console.log(`✓ Queue has ${queue.length} songs`);
    queue.forEach((song, i) => {
      console.log(`  ${i + 1}. "${song.title}" by ${song.channelTitle} (${song.requester})`);
    });

    // 3. Test POST /api/song-queue/skip - Skip first song
    console.log('\n3. Testing skip command (should skip "Test Song 1")...');
    const skipResponse = await axios.post(`${BASE_URL}/skip`);
    if (skipResponse.data.success) {
      const skipped = skipResponse.data.skippedSong;
      console.log(`✓ Skipped: "${skipped.title}"`);
      console.log(`  Queue now has ${skipResponse.data.queueLength} songs`);
    } else {
      console.log(`✗ Skip failed: ${skipResponse.data.error}`);
    }

    // 4. Verify queue after skip
    queueResponse = await axios.get(BASE_URL);
    queue = queueResponse.data.active;
    console.log('\n4. Queue after skip:');
    queue.forEach((song, i) => {
      console.log(`  ${i + 1}. "${song.title}" by ${song.channelTitle}`);
    });

    // 5. Test DELETE /api/song-queue/:target - Remove by position
    console.log('\n5. Testing remove by position (position 2)...');
    const removeByPosResponse = await axios.delete(`${BASE_URL}/2`);
    if (removeByPosResponse.data.success) {
      const removed = removeByPosResponse.data.removedSong;
      console.log(`✓ Removed position 2: "${removed.title}"`);
      console.log(`  Queue now has ${removeByPosResponse.data.queueLength} songs`);
    } else {
      console.log(`✗ Remove failed: ${removeByPosResponse.data.error}`);
    }

    // 6. Add more songs for keyword test
    console.log('\n6. Adding more songs for keyword removal test...');
    const moreSongs = [
      {
        videoId: 'test4',
        title: 'Another Rick Roll',
        channelTitle: 'Rick Astley',
        channelId: 'rickastley',
        durationSeconds: 200,
        durationFormatted: '3:20',
        thumbnail: 'http://example.com/thumb4.jpg',
        requester: 'testuser3',
        requesterDisplayName: 'TestUser3'
      },
      {
        videoId: 'test5',
        title: 'Normal Song',
        channelTitle: 'Normal Artist',
        channelId: 'normalartist',
        durationSeconds: 180,
        durationFormatted: '3:00',
        thumbnail: 'http://example.com/thumb5.jpg',
        requester: 'testuser4',
        requesterDisplayName: 'TestUser4'
      }
    ];

    for (const song of moreSongs) {
      const response = await axios.post(`${BASE_URL}/add`, song);
      console.log(`✓ Added: "${song.title}"`);
    }

    // 7. Test DELETE /api/song-queue/:target - Remove by keyword
    console.log('\n7. Testing remove by keyword ("rick")...');
    const removeByKeywordResponse = await axios.delete(`${BASE_URL}/${encodeURIComponent('rick')}`);
    if (removeByKeywordResponse.data.success) {
      const removed = removeByKeywordResponse.data.removedSong;
      console.log(`✓ Removed by keyword: "${removed.title}" by ${removed.channelTitle}`);
      console.log(`  Queue now has ${removeByKeywordResponse.data.queueLength} songs`);
    } else {
      console.log(`✗ Remove failed: ${removeByKeywordResponse.data.error}`);
    }

    // 8. Verify queue state
    queueResponse = await axios.get(BASE_URL);
    queue = queueResponse.data.active;
    console.log('\n8. Queue before clear:');
    queue.forEach((song, i) => {
      console.log(`  ${i + 1}. "${song.title}" by ${song.channelTitle}`);
    });

    // 9. Test POST /api/song-queue/clear - Clear entire queue
    console.log('\n9. Testing clear queue command...');
    const clearResponse = await axios.post(`${BASE_URL}/clear`);
    if (clearResponse.data.success) {
      console.log(`✓ Cleared ${clearResponse.data.clearedCount} song(s) from queue`);
    } else {
      console.log(`✗ Clear failed: ${clearResponse.data.error}`);
    }

    // 10. Verify queue is empty
    queueResponse = await axios.get(BASE_URL);
    queue = queueResponse.data.active;
    console.log('\n10. Final queue state:');
    if (queue.length === 0) {
      console.log('  ✓ Queue is empty');
    } else {
      console.log(`  ✗ Queue still has ${queue.length} songs`);
    }

    // 11. Test error cases
    console.log('\n11. Testing error cases...');

    // Skip on empty queue
    const skipEmptyResponse = await axios.post(`${BASE_URL}/skip`);
    if (!skipEmptyResponse.data.success) {
      console.log(`  ✓ Skip on empty queue returns error: "${skipEmptyResponse.data.error}"`);
    }

    // Remove on empty queue
    const removeEmptyResponse = await axios.delete(`${BASE_URL}/1`);
    if (!removeEmptyResponse.data.success) {
      console.log(`  ✓ Remove on empty queue returns error: "${removeEmptyResponse.data.error}"`);
    }

    // Clear on empty queue
    const clearEmptyResponse = await axios.post(`${BASE_URL}/clear`);
    if (clearEmptyResponse.data.success && clearEmptyResponse.data.clearedCount === 0) {
      console.log(`  ✓ Clear on empty queue returns success with 0 count`);
    }

    console.log('\n=== All tests completed ===');

  } catch (error) {
    console.error('\n✗ Test error:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

// Run tests
testModeratorCommands();
