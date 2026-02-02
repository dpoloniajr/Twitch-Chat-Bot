const express = require('express');
const router = express.Router();
const AccountManager = require('../account-manager');
const accountManager = new AccountManager();
const { asyncHandler, validateRequest, ValidationError } = require('../lib/api-utils');

const accountSchema = {
    accountName: { required: true, type: 'string' },
    clientId: { required: true, type: 'string' },
    clientSecret: { required: true, type: 'string' },
    broadcasterName: { required: true, type: 'string' }
};

// List all accounts
router.get('/', asyncHandler(async (req, res) => {
    const accounts = accountManager.listAccounts();
    res.json({ success: true, accounts });
}));

// Get single account
router.get('/:name', asyncHandler(async (req, res) => {
    const account = accountManager.getAccount(req.params.name);
    if (!account) throw new ValidationError('Account not found', 404);
    
    // Return sanitized account info
    const publicInfo = {
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
    res.json({ success: true, account: publicInfo });
}));

// Create new account
router.post('/', validateRequest(accountSchema), asyncHandler(async (req, res) => {
    const { accountName, clientId, clientSecret, broadcasterName, channels = [] } = req.body;
    const account = accountManager.createAccount(accountName, clientId, clientSecret, broadcasterName, channels);
    res.json({ success: true, message: `Account "${accountName}" created`, account });
}));

// Delete account
router.delete('/:name', asyncHandler(async (req, res) => {
    accountManager.deleteAccount(req.params.name);
    res.json({ success: true, message: `Account "${req.params.name}" deleted` });
}));

// Import account from .env content
router.post('/import', (req, res) => {
    try {
        const { accountName, envContent } = req.body;
        if (!accountName || !envContent) throw new Error('accountName and envContent are required');
        const account = accountManager.importFromEnv(accountName, envContent);
        res.json({ success: true, message: 'Account imported successfully', name: account.name });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;
