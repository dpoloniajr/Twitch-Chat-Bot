/**
 * Common utilities for API routes and error handling
 */

class ValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = statusCode;
  }
}

/**
 * Wrapper for async route handlers to catch errors and pass them to next()
 */
const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Middleware factory to validate request body against a simple schema
 */
function validateRequest(schema) {
  return (req, res, next) => {
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

module.exports = {
  ValidationError,
  asyncHandler,
  validateRequest
};
