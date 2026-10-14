/**
 * Common utilities for API routes and error handling
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * An error whose message is safe to show to the client, with the HTTP status to send.
 */
export class ValidationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = statusCode;
  }
}

/**
 * Wrap an async route handler so a rejected promise reaches next() instead of being lost.
 */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/** Rules for one request body field */
export interface FieldRules {
  required?: boolean;
  /** Expected `typeof` result, e.g. 'string' or 'number' */
  type?: string;
  min?: number;
  max?: number;
}

export type RequestSchema = Record<string, FieldRules>;

/**
 * Middleware factory that checks the request body against a simple schema and
 * passes a ValidationError for the first field that fails.
 */
export function validateRequest(schema: RequestSchema): RequestHandler {
  return (req, _res, next) => {
    for (const [field, rules] of Object.entries(schema)) {
      const value = req.body[field];

      if (rules.required && (value === undefined || value === null || value === '')) {
        return next(new ValidationError(`${field} is required`));
      }

      if (value !== undefined && value !== null) {
        if (rules.type && typeof value !== rules.type) {
          return next(new ValidationError(`${field} must be a ${rules.type}`));
        }
        if (rules.min !== undefined && value < rules.min) {
          return next(new ValidationError(`${field} must be at least ${rules.min}`));
        }
        if (rules.max !== undefined && value > rules.max) {
          return next(new ValidationError(`${field} must be at most ${rules.max}`));
        }
      }
    }
    next();
  };
}
