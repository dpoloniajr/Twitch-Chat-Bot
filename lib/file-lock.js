const fs = require('fs').promises;
const path = require('path');

/**
 * Cross-process file locking using atomic directory creation.
 * This ensures that multiple processes (Bot, Dashboard, Token Generator)
 * don't write to the same file simultaneously.
 */

async function withCrossProcessLock(filePath, action, options = {}) {
  const {
    lockDir = filePath + '.lock',
    retries = 20,
    retryDelay = 100
  } = options;

  let acquired = false;
  
  for (let i = 0; i < retries; i++) {
    try {
      // mkdir is atomic across processes
      await fs.mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Lock already exists, wait and retry
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      throw err;
    }
  }

  if (!acquired) {
    throw new Error(`Could not acquire lock for ${filePath} after ${retries} attempts`);
  }

  try {
    return await action();
  } finally {
    try {
      await fs.rmdir(lockDir);
    } catch (err) {
      // If we can't remove the lock, it's a serious issue, but we already finished the action
      console.error(`Failed to release lock for ${filePath}:`, err.message);
    }
  }
}

module.exports = {
  withCrossProcessLock,
  /**
   * Synchronous version of cross-process file locking.
   * Useful for legacy code or when async/await is not preferred.
   */
  withCrossProcessLockSync: function(filePath, action, options = {}) {
    const fsSync = require('fs');
    const {
      lockDir = filePath + '.lock',
      retries = 20,
      retryDelay = 100
    } = options;

    let acquired = false;
    
    for (let i = 0; i < retries; i++) {
      try {
        fsSync.mkdirSync(lockDir);
        acquired = true;
        break;
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Simple busy-wait for sync version
          const start = Date.now();
          while (Date.now() - start < retryDelay) {
            // busy wait
          }
          continue;
        }
        throw err;
      }
    }

    if (!acquired) {
      throw new Error(`Could not acquire lock for ${filePath} after ${retries} attempts`);
    }

    try {
      return action();
    } finally {
      try {
        fsSync.rmdirSync(lockDir);
      } catch (err) {
        console.error(`Failed to release lock for ${filePath}:`, err.message);
      }
    }
  }
};
