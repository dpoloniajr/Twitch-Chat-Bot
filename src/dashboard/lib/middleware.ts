/**
 * Express middleware shared by the dashboard API
 */

import * as crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/** An error that may carry the HTTP status to send (e.g. ValidationError) */
export interface HttpError extends Error {
  statusCode?: number;
}

/**
 * Global error handling middleware for the dashboard API
 */
export function errorHandler(err: HttpError, req: Request, res: Response, next: NextFunction): void {
  // Log error stack for 500s
  if (!err.statusCode || err.statusCode === 500) {
    console.error('API Error:', err.stack);
  }

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    success: false,
    error: message,
    // Include stack in development if needed, but keeping it simple for now
  });
}

/** Methods that only read state; everything else counts as a write */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True when the request only reads (GET/HEAD/OPTIONS) */
export function isReadOnlyRequest(req: Request): boolean {
  return SAFE_METHODS.has(req.method);
}

/**
 * Cross-site request forgery guard for state-changing requests. Browsers send an
 * Origin header with cross-origin (and same-origin non-GET) requests, so a write
 * is allowed when it has no Origin (the bot, curl and other non-browser clients)
 * or when the Origin's host:port equals the request's Host header (the dashboard
 * pages and OBS overlays served by this server). Any other origin, including the
 * opaque "null" origin, gets 403.
 */
export function sameOriginGuard(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (isReadOnlyRequest(req) || origin === undefined) return next();

  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    // Unparseable (e.g. "null"): treated as cross-site
  }
  const host = (req.headers.host || '').toLowerCase();
  if (originHost && host && originHost === host) return next();

  res.status(403).json({ error: 'Forbidden: cross-site request' });
}

/**
 * Require the bot's shared secret (x-bot-secret header) on write requests when
 * `secret` (DASHBOARD_INTERNAL_SECRET) is configured; without one every request
 * passes (backwards compatible). Read-only requests always pass.
 */
export function requireBotSecret(secret: string | undefined): (req: Request, res: Response, next: NextFunction) => void {
  const expected = secret ? Buffer.from(secret) : null;
  return (req, res, next) => {
    if (!expected || isReadOnlyRequest(req)) return next();
    const header = req.headers['x-bot-secret'];
    const given = Buffer.from(typeof header === 'string' ? header : '');
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.status(403).json({ error: 'Forbidden' });
  };
}

/**
 * Let a write through `botOnly` when it comes from a dashboard page instead of
 * the bot. Browser pages cannot hold the bot secret, but they always send an
 * Origin header on writes, and sameOriginGuard (which runs first) has already
 * rejected every Origin other than this server's own. So a write that carries
 * an Origin here is from a dashboard page; one without needs the bot secret.
 * Used for the admin actions the dashboard pages offer (song queue management,
 * loyalty settings and point edits) on routes that are otherwise bot-only.
 */
export function allowDashboardPages(
  botOnly: (req: Request, res: Response, next: NextFunction) => void
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (typeof req.headers.origin === 'string' && req.headers.origin !== '') return next();
    botOnly(req, res, next);
  };
}

/**
 * Give body-less requests an empty body. Express 5 leaves req.body undefined when
 * a request has no (JSON/urlencoded) body, which made validation and destructuring
 * throw TypeErrors (500) instead of answering 400.
 */
export function ensureBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.body === undefined) req.body = {};
  next();
}
