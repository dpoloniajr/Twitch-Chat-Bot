/**
 * Tests for src/lib/api-utils.ts (also loaded through the lib/api-utils.js shim)
 */

import type { NextFunction, Request, Response } from 'express';
import { ValidationError, asyncHandler, validateRequest, RequestSchema } from '../../src/lib/api-utils';

function run(schema: RequestSchema, body: Record<string, unknown>): unknown {
  const next = jest.fn();
  validateRequest(schema)({ body } as Request, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return next.mock.calls[0][0];
}

describe('api-utils', () => {
  describe('ValidationError', () => {
    it('defaults to status 400 and keeps its name and message', () => {
      const err = new ValidationError('bad');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.name).toBe('ValidationError');
      expect(err.message).toBe('bad');
      expect(err.statusCode).toBe(400);
    });

    it('accepts a custom status', () => {
      expect(new ValidationError('missing', 404).statusCode).toBe(404);
    });
  });

  describe('asyncHandler', () => {
    const req = {} as Request;
    const res = {} as Response;

    it('passes a rejected promise to next', async () => {
      const boom = new Error('boom');
      const next = jest.fn();
      asyncHandler(async () => { throw boom; })(req, res, next as NextFunction);
      await new Promise(setImmediate);
      expect(next).toHaveBeenCalledWith(boom);
    });

    it('lets a synchronous throw propagate to the caller (Express 5 catches it)', () => {
      const boom = new Error('sync');
      const next = jest.fn();
      expect(() => asyncHandler(() => { throw boom; })(req, res, next as NextFunction)).toThrow(boom);
      expect(next).not.toHaveBeenCalled();
    });

    it('does not call next when the handler succeeds', async () => {
      const next = jest.fn();
      const handler = jest.fn(async () => 'done');
      asyncHandler(handler)(req, res, next as NextFunction);
      await new Promise(setImmediate);
      expect(handler).toHaveBeenCalledWith(req, res, next);
      expect(next).not.toHaveBeenCalled();
    });

    it('works with a handler that returns a plain value', async () => {
      const next = jest.fn();
      asyncHandler(() => 42)(req, res, next as NextFunction);
      await new Promise(setImmediate);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('validateRequest', () => {
    const schema: RequestSchema = {
      name: { required: true, type: 'string' },
      age: { type: 'number', min: 18, max: 99 }
    };

    it('calls next with no error for a valid body', () => {
      expect(run(schema, { name: 'Dom', age: 30 })).toBeUndefined();
    });

    it.each([
      ['missing', {}],
      ['null', { name: null }],
      ['empty string', { name: '' }]
    ])('rejects a required field that is %s', (_label, body) => {
      const err = run(schema, body as Record<string, unknown>);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toBe('name is required');
    });

    it('accepts falsy values that are present for required fields', () => {
      expect(run({ n: { required: true } }, { n: 0 })).toBeUndefined();
      expect(run({ b: { required: true } }, { b: false })).toBeUndefined();
    });

    it('rejects the wrong type', () => {
      expect((run(schema, { name: 'Dom', age: '30' }) as Error).message).toBe('age must be a number');
    });

    it('enforces min and max, inclusive at the bounds', () => {
      expect((run(schema, { name: 'a', age: 17 }) as Error).message).toBe('age must be at least 18');
      expect((run(schema, { name: 'a', age: 100 }) as Error).message).toBe('age must be at most 99');
      expect(run(schema, { name: 'a', age: 18 })).toBeUndefined();
      expect(run(schema, { name: 'a', age: 99 })).toBeUndefined();
    });

    it('skips checks for optional fields that are absent or null', () => {
      expect(run(schema, { name: 'a', age: null })).toBeUndefined();
      expect(run(schema, { name: 'a' })).toBeUndefined();
    });

    it('reports only the first failing field, in schema order', () => {
      expect((run(schema, { age: 1 }) as Error).message).toBe('name is required');
    });

    it('ignores fields not in the schema', () => {
      expect(run(schema, { name: 'a', extra: { deep: true } })).toBeUndefined();
    });
  });
});
