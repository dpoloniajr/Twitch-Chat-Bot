/**
 * OAuth helper routes: auth URL generation, token validation, connection test.
 */

import express, { Router } from 'express';
import axios from 'axios';
import type { EnvManager } from '../../lib/env-manager';

/** Body of https://id.twitch.tv/oauth2/validate (fields used here) */
interface TwitchValidateResponse {
  scopes?: string[];
  expires_in?: number;
}

/** Helix user (fields used here; the whole object is passed on by test-connection) */
interface TwitchUser {
  id: string;
  display_name: string;
  [key: string]: unknown;
}

interface TwitchUsersResponse {
  data: TwitchUser[];
}

/** axios error shape: Twitch puts a readable message in response.data.message */
interface HttpError {
  message: string;
  response?: { data?: { message?: string } };
}

interface GenerateAuthUrlBody {
  scopes?: unknown;
  accountType?: string;
}

interface TestConnectionBody {
  token?: string;
  type?: string;
}

/**
 * @param envManager - .env holding TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET
 * @param REDIRECT_URI - the token generator's /callback URL
 */
export function createAuthRoutes(envManager: EnvManager, REDIRECT_URI: string): Router {
  const router = express.Router();

  // Helper to get Twitch credentials from .env
  async function getTwitchCredentials(): Promise<{ clientId: string | undefined; clientSecret: string | undefined }> {
    const env = await envManager.getEnv();
    return {
      clientId: env.TWITCH_CLIENT_ID,
      clientSecret: env.TWITCH_CLIENT_SECRET
    };
  }

  // Generate auth URL
  router.post('/api/generate-auth-url', async (req, res) => {
    const { scopes, accountType } = req.body as GenerateAuthUrlBody;
    const { clientId } = await getTwitchCredentials();

    if (!clientId) {
      res.status(400).json({ error: 'TWITCH_CLIENT_ID not found in .env' });
      return;
    }

    if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
      res.status(400).json({ error: 'No scopes provided' });
      return;
    }

    const scopeString = scopes.join(' ');
    const state = encodeURIComponent(accountType || 'bot');
    const authUrl = `https://id.twitch.tv/oauth2/authorize?` +
      `client_id=${clientId}&` +
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent(scopeString)}&` +
      `state=${state}`;

    res.json({ authUrl });
  });

  // Validate token
  router.get('/api/validate-token', async (req, res) => {
    const { token } = req.query as { token?: string };
    const { clientId } = await getTwitchCredentials();

    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'No token provided' });
      return;
    }

    try {
      const tokenInfoResponse = await axios.get<TwitchValidateResponse>('https://id.twitch.tv/oauth2/validate', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const userResponse = await axios.get<TwitchUsersResponse>('https://api.twitch.tv/helix/users', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Client-ID': clientId
        }
      });

      const user = userResponse.data.data?.[0];
      if (!user) {
        res.status(401).json({ success: false, valid: false, error: 'No Twitch user found for this token' });
        return;
      }
      res.json({
        success: true,
        valid: true,
        username: user.display_name,
        userId: user.id,
        scopes: tokenInfoResponse.data.scopes || [],
        expiresIn: tokenInfoResponse.data.expires_in
      });
    } catch (error) {
      const err = error as HttpError;
      res.status(401).json({ success: false, valid: false, error: err.response?.data?.message || err.message });
    }
  });

  // Test connection
  router.post('/api/test-connection', async (req, res) => {
    const { token, type } = req.body as TestConnectionBody;
    if (!token) {
      res.status(400).json({ success: false, error: 'No token provided' });
      return;
    }

    try {
      const env = await envManager.getEnv();
      const clientId = env.TWITCH_CLIENT_ID;

      const userResponse = await axios.get<TwitchUsersResponse>('https://api.twitch.tv/helix/users', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Client-ID': clientId
        }
      });

      res.json({
        success: true,
        message: `Connection test successful for ${type}`,
        data: userResponse.data.data[0]
      });
    } catch (error) {
      const err = error as HttpError;
      res.status(500).json({
        success: false,
        error: err.response?.data?.message || err.message
      });
    }
  });

  return router;
}
