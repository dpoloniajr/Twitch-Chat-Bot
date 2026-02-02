const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { MIME_SIGNATURES, UPLOAD_LIMIT_WINDOW, UPLOAD_LIMIT_COUNT } = require('./constants');

class ValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = statusCode;
  }
}

// Simple in-memory lock/queue to prevent race conditions within the same process
const fileLocks = new Map();

async function withFileLock(filePath, action) {
  if (!fileLocks.has(filePath)) {
    fileLocks.set(filePath, Promise.resolve());
  }

  const previousLock = fileLocks.get(filePath);
  const newLock = (async () => {
    await previousLock;
    try {
      return await action();
    } finally {
      // No-op, just ensuring we proceed to next action
    }
  })();

  fileLocks.set(filePath, newLock.catch(() => {})); // Prevent chain break on error
  return newLock;
}

async function upsertEnvValue(envPath, key, value) {
  return withFileLock(envPath, async () => {
    const line = `${key}=${value}`;
    let envContent = '';
    try {
      envContent = await fs.readFile(envPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (envContent) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, line);
      } else {
        envContent = envContent.trimEnd();
        envContent += (envContent.endsWith('\n') ? '' : '\n') + line + '\n';
      }
    } else {
      envContent = line + '\n';
    }

    await fs.writeFile(envPath, envContent);
  });
}

function validateMimeType(buffer, ext) {
  const signature = MIME_SIGNATURES[ext];
  if (!signature) {
    return false;
  }

  if (ext === '.webp' || ext === '.wav') {
    if (buffer.length < 12) return false;
    if (buffer[0] !== 0x52 || buffer[1] !== 0x49 || buffer[2] !== 0x46 || buffer[3] !== 0x46) {
      return false;
    }
    if (ext === '.webp') {
      return buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
    }
    if (ext === '.wav') {
      return buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45;
    }
  }

  if (ext === '.mp4' || ext === '.m4a' || ext === '.mov') {
    if (buffer.length < 8) return false;
    return buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70;
  }

  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

const uploadRateLimits = new Map();

function checkUploadRateLimit(ip) {
  const now = Date.now();
  if (!uploadRateLimits.has(ip)) {
    uploadRateLimits.set(ip, []);
  }

  const timestamps = uploadRateLimits.get(ip).filter(t => now - t < UPLOAD_LIMIT_WINDOW);
  uploadRateLimits.set(ip, timestamps);

  if (timestamps.length >= UPLOAD_LIMIT_COUNT) {
    return false;
  }

  timestamps.push(now);
  return true;
}

module.exports = {
  ValidationError,
  withFileLock,
  upsertEnvValue,
  validateMimeType,
  checkUploadRateLimit
};
