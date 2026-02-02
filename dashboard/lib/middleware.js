/**
 * Global error handling middleware for the dashboard API
 */
function errorHandler(err, req, res, next) {
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

module.exports = {
  errorHandler
};
