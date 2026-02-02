const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { ValidationError, validateMimeType, checkUploadRateLimit, asyncHandler, validateRequest } = require('../lib/utils');
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

    if (!allowedTypes.includes(ext)) {
      throw new ValidationError(`Invalid file type. Allowed: ${allowedTypes.join(', ')}`, 415);
    }

    const buffer = Buffer.from(base64Data.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buffer.length > 10 * 1024 * 1024) {
      throw new ValidationError('File size exceeds 10MB limit', 413);
    }
    
    if (!validateMimeType(buffer, ext)) {
      throw new ValidationError(`File content does not match ${ext} format.`, 415);
    }

    const uniqueId = crypto.randomBytes(8).toString('hex');
    const uniqueFilename = `${uniqueId}_${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const filePath = path.join(targetDir, uniqueFilename);

    await fs.writeFile(filePath, buffer);

    return { 
      filename: uniqueFilename, 
      path: `/uploads/${mediaType}s/${uniqueFilename}`, 
      size: buffer.length, 
      type: mediaType 
    };
  }

  const uploadSchema = {
    data: { required: true, type: 'string' },
    filename: { required: true, type: 'string' }
  };

  const handleUpload = (mediaType) => [
    validateRequest(uploadSchema),
    asyncHandler(async (req, res) => {
      const clientIp = req.ip || req.connection.remoteAddress;
      if (!checkUploadRateLimit(clientIp)) {
        throw new ValidationError('Rate limit exceeded', 429);
      }

      const { data, filename } = req.body;
      const result = await saveUploadedMedia(data, filename, mediaType);
      res.json({ success: true, ...result });
    })
  ];

  router.post('/image', handleUpload('image'));
  router.post('/video', handleUpload('video'));
  router.post('/sound', handleUpload('sound'));

  router.get('/:mediaType', asyncHandler(async (req, res) => {
    const { mediaType } = req.params;
    const validTypes = ['images', 'videos', 'sounds'];
    if (!validTypes.includes(mediaType)) {
      throw new ValidationError('Invalid media type');
    }

    const targetDir = path.join(uploadsDir, mediaType);
    const files = await fs.readdir(targetDir);
    
    const fileList = await Promise.all(files.map(async (f) => {
      const s = await fs.stat(path.join(targetDir, f));
      return { 
        filename: f, 
        path: `/uploads/${mediaType}/${f}`, 
        size: s.size, 
        modified: s.mtime 
      };
    }));
    
    res.json({ success: true, files: fileList });
  }));

  router.delete('/:mediaType/:filename', asyncHandler(async (req, res) => {
    const { mediaType, filename } = req.params;
    const filePath = path.join(uploadsDir, mediaType, path.basename(filename));
    
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new ValidationError('File not found', 404);
      }
      throw error;
    }
    
    res.json({ success: true, deleted: filename });
  }));

  return router;
};
