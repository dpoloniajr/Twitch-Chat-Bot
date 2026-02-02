const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { ValidationError, validateMimeType, checkUploadRateLimit } = require('../lib/utils');
const { SUPPORTED_IMAGE_TYPES, SUPPORTED_VIDEO_TYPES, SUPPORTED_AUDIO_TYPES } = require('../lib/constants');

module.exports = function(uploadsDir) {
  async function saveUploadedMedia(base64Data, filename, mediaType) {
    const ext = path.extname(filename).toLowerCase();
    let targetDir, allowedTypes;

    switch (mediaType) {
      case 'image': targetDir = path.join(uploadsDir, 'images'); allowedTypes = SUPPORTED_IMAGE_TYPES; break;
      case 'video': targetDir = path.join(uploadsDir, 'videos'); allowedTypes = SUPPORTED_VIDEO_TYPES; break;
      case 'sound': targetDir = path.join(uploadsDir, 'sounds'); allowedTypes = SUPPORTED_AUDIO_TYPES; break;
      default: throw new ValidationError('Invalid media type');
    }

    if (!allowedTypes.includes(ext)) throw new ValidationError(`Invalid file type. Allowed: ${allowedTypes.join(', ')}`, 415);

    const buffer = Buffer.from(base64Data.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buffer.length > 10 * 1024 * 1024) throw new ValidationError('File size exceeds 10MB limit', 413);
    if (!validateMimeType(buffer, ext)) throw new ValidationError(`File content does not match ${ext} format.`, 415);

    const uniqueId = crypto.randomBytes(8).toString('hex');
    const uniqueFilename = `${uniqueId}_${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const filePath = path.join(targetDir, uniqueFilename);

    await fs.writeFile(filePath, buffer);

    return { filename: uniqueFilename, path: `/uploads/${mediaType}s/${uniqueFilename}`, size: buffer.length, type: mediaType };
  }

  const handleUpload = (mediaType) => async (req, res) => {
    try {
      const clientIp = req.ip || req.connection.remoteAddress;
      if (!checkUploadRateLimit(clientIp)) return res.status(429).json({ error: 'Rate limit exceeded' });

      const { data, filename } = req.body;
      if (!data || !filename) return res.status(400).json({ error: 'data and filename required' });

      const result = await saveUploadedMedia(data, filename, mediaType);
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  };

  router.post('/image', handleUpload('image'));
  router.post('/video', handleUpload('video'));
  router.post('/sound', handleUpload('sound'));

  router.get('/:mediaType', async (req, res) => {
    try {
      const { mediaType } = req.params;
      const validTypes = ['images', 'videos', 'sounds'];
      if (!validTypes.includes(mediaType)) return res.status(400).json({ error: 'Invalid media type' });

      const targetDir = path.join(uploadsDir, mediaType);
      const files = await fs.readdir(targetDir);
      const fileList = await Promise.all(files.map(async (f) => {
        const s = await fs.stat(path.join(targetDir, f));
        return { filename: f, path: `/uploads/${mediaType}/${f}`, size: s.size, modified: s.mtime };
      }));
      res.json({ success: true, files: fileList });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/:mediaType/:filename', async (req, res) => {
    try {
      const { mediaType, filename } = req.params;
      const filePath = path.join(uploadsDir, mediaType, path.basename(filename));
      await fs.unlink(filePath);
      res.json({ success: true, deleted: filename });
    } catch (error) {
      res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: error.message });
    }
  });

  return router;
};
