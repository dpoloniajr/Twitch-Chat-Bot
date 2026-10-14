/**
 * Upload routes (mounted at /api/uploads): save base64-encoded images, videos
 * and sounds for alerts, list them, and delete them.
 */

import { Router } from 'express';
import type { RequestHandler } from 'express';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ValidationError, validateMimeType, checkUploadRateLimit, asyncHandler, validateRequest } from '../lib/utils';
import { SUPPORTED_IMAGE_TYPES, SUPPORTED_VIDEO_TYPES, SUPPORTED_AUDIO_TYPES } from '../lib/constants';

/** Kinds of media the upload routes accept */
export type MediaType = 'image' | 'video' | 'sound';

/** Response body (after `success: true`) for a saved upload */
export interface SavedUpload {
  filename: string;
  path: string;
  size: number;
  type: string;
}

/** Upload sub-folders, as named in the list and delete URLs */
const MEDIA_FOLDERS = ['images', 'videos', 'sounds'];

/** True for a bare file name: no path separators, not "." or ".." */
function isPlainFilename(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

/**
 * Create the /api/uploads router. Each call returns a new router that stores files under `uploadsDir`.
 */
export function createUploadsRouter(uploadsDir: string): Router {
  const router = Router();

  async function saveUploadedMedia(base64Data: string, filename: string, mediaType: string): Promise<SavedUpload> {
    const ext = path.extname(filename).toLowerCase();
    let targetDir: string, allowedTypes: string[];

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

  const handleUpload = (mediaType: MediaType): RequestHandler[] => [
    validateRequest(uploadSchema),
    asyncHandler(async (req, res) => {
      // Unknown addresses share one bucket (fail closed)
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
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
    const mediaType = req.params.mediaType as string;
    if (!MEDIA_FOLDERS.includes(mediaType)) {
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

  // Both params arrive URL-decoded, so they are checked before touching the disk:
  // the folder must be a known media folder and the filename a bare file name
  router.delete('/:mediaType/:filename', asyncHandler(async (req, res) => {
    const mediaType = req.params.mediaType as string;
    const filename = req.params.filename as string;
    if (!MEDIA_FOLDERS.includes(mediaType)) {
      throw new ValidationError('Invalid media type');
    }
    if (!isPlainFilename(filename)) {
      throw new ValidationError('Invalid filename');
    }
    const filePath = path.join(uploadsDir, mediaType, filename);

    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ValidationError('File not found', 404);
      }
      throw error;
    }

    res.json({ success: true, deleted: filename });
  }));

  return router;
}
