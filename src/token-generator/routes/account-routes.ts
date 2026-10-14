/**
 * Routes under /api/accounts: account CRUD and .env import.
 */

import express, { Router } from 'express';
import type { Account, AccountManager } from '../../lib/account-manager';
import { asyncHandler, validateRequest, ValidationError, RequestSchema } from '../../lib/api-utils';

const accountSchema: RequestSchema = {
  accountName: { required: true, type: 'string' },
  clientId: { required: true, type: 'string' },
  clientSecret: { required: true, type: 'string' },
  broadcasterName: { required: true, type: 'string' }
};

interface CreateAccountBody {
  accountName: string;
  clientId: string;
  clientSecret: string;
  broadcasterName: string;
  channels?: string[];
}

interface ImportAccountBody {
  accountName?: string;
  envContent?: string;
}

/**
 * An account as the API returns it: no client secret and no tokens, only
 * whether each token is present and its status.
 */
function toPublicAccount(accountManager: AccountManager, account: Account) {
  return {
    name: account.name,
    clientId: account.clientId,
    broadcasterName: account.broadcasterName,
    channels: account.channels,
    tokenScopes: account.tokenScopes,
    broadcasterScopes: account.broadcasterScopes,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    hasAccessToken: !!account.accessToken,
    hasBroadcasterToken: !!account.broadcasterAccessToken,
    tokenStatus: accountManager.getTokenStatus(account.tokenExpiresAt),
    broadcasterTokenStatus: accountManager.getTokenStatus(account.broadcasterTokenExpiresAt)
  };
}

export function createAccountRoutes(accountManager: AccountManager): Router {
  const router = express.Router();

  // List all accounts
  router.get('/', asyncHandler(async (req, res) => {
    const accounts = accountManager.listAccounts();
    res.json({ success: true, accounts });
  }));

  // Get single account
  router.get('/:name', asyncHandler(async (req, res) => {
    const account = accountManager.getAccount(req.params.name as string);
    if (!account) throw new ValidationError('Account not found', 404);
    res.json({ success: true, account: toPublicAccount(accountManager, account) });
  }));

  // Create new account
  router.post('/', validateRequest(accountSchema), asyncHandler(async (req, res) => {
    const { accountName, clientId, clientSecret, broadcasterName, channels = [] } = req.body as CreateAccountBody;
    const account = accountManager.createAccount(accountName, clientId, clientSecret, broadcasterName, channels);
    res.json({ success: true, message: `Account "${accountName}" created`, account: toPublicAccount(accountManager, account) });
  }));

  // Delete account
  router.delete('/:name', asyncHandler(async (req, res) => {
    accountManager.deleteAccount(req.params.name as string);
    res.json({ success: true, message: `Account "${req.params.name}" deleted` });
  }));

  // Import account from .env content
  router.post('/import', (req, res) => {
    try {
      const { accountName, envContent } = req.body as ImportAccountBody;
      if (!accountName || !envContent) throw new Error('accountName and envContent are required');
      const account = accountManager.importFromEnv(accountName, envContent);
      res.json({ success: true, message: 'Account imported successfully', name: account.name });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
