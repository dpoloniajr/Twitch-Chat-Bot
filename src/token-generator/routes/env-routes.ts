/**
 * Routes under /api/env: token status and .env backups.
 */

import express, { Router } from 'express';
import type { EnvManager } from '../../lib/env-manager';
import { ValidationError } from '../../lib/api-utils';

export function createEnvRoutes(envManager: EnvManager): Router {
  const router = express.Router();

  // Get current token status
  router.get('/status', async (req, res) => {
    try {
      const env = await envManager.getEnv();
      res.json({
        success: true,
        botToken: !!env.TWITCH_ACCESS_TOKEN,
        broadcasterToken: !!env.TWITCH_BROADCASTER_ACCESS_TOKEN,
        clientId: !!env.TWITCH_CLIENT_ID,
        clientSecret: !!env.TWITCH_CLIENT_SECRET
      });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  // List backups
  router.get('/backups', (req, res) => {
    try {
      const backups = envManager.listBackups();
      res.json({ success: true, backups });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  // Create backup
  router.post('/backup', async (req, res) => {
    try {
      const backupName = await envManager.createBackup();
      res.json({ success: true, backupName });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  // Restore backup (only a backup file name from /backups; see EnvManager.restoreBackup)
  router.post('/restore', async (req, res) => {
    const { backupName } = req.body as { backupName?: unknown };
    if (!backupName) {
      res.status(400).json({ success: false, error: 'backupName is required' });
      return;
    }

    try {
      await envManager.restoreBackup(backupName as string);
      res.json({ success: true, message: 'Restore successful' });
    } catch (error) {
      const status = error instanceof ValidationError ? error.statusCode : 500;
      res.status(status).json({ success: false, error: (error as Error).message });
    }
  });

  return router;
}
