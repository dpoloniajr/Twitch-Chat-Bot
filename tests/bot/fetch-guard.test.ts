/**
 * Unit tests for the custom-command SSRF guard (src/bot/fetch-guard.ts).
 * The end-to-end refusals are covered in tests/e2e/bot-chat-pipeline.test.ts.
 */

import {
  checkFetchUrl,
  createGuardedLookup,
  INTERNAL_URL_ERROR,
  isInternalAddress,
  refuseInternalRedirect
} from '../../src/bot/fetch-guard';

describe('isInternalAddress', () => {
  it.each([
    '127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '[::1]', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '[::ffff:10.0.0.1]'
  ])('%s is internal', (address) => {
    expect(isInternalAddress(address)).toBe(true);
  });

  it.each([
    '93.184.216.34', '172.32.0.1', '172.15.255.255', '192.169.0.1', '100.128.0.1', '8.8.8.8',
    '2606:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808', 'example.com', ''
  ])('%s is not internal', (address) => {
    expect(isInternalAddress(address)).toBe(false);
  });
});

describe('checkFetchUrl', () => {
  it.each([
    'http://localhost/x', 'http://LOCALHOST./x', 'http://a.localhost/x', 'http://[::1]:8080/x',
    'http://0x7f.1/x', 'http://2130706433/x', 'https://10.0.0.1/x'
  ])('refuses %s', (url) => {
    expect(checkFetchUrl(new URL(url))).toBe(INTERNAL_URL_ERROR);
  });

  it('refuses non-http(s) schemes', () => {
    expect(checkFetchUrl(new URL('file:///etc/passwd'))).toBe('Only http(s) URLs are allowed');
    expect(checkFetchUrl(new URL('ftp://example.com/x'))).toBe('Only http(s) URLs are allowed');
  });

  it('allows public hosts (hostnames are checked again when they resolve)', () => {
    expect(checkFetchUrl(new URL('https://api.example.com/joke'))).toBeNull();
    expect(checkFetchUrl(new URL('http://93.184.216.34/'))).toBeNull();
  });
});

describe('createGuardedLookup', () => {
  const run = (addresses: Array<{ address: string; family: number }> | Error) =>
    new Promise<{ err: Error | null; result: unknown }>((resolve) => {
      const resolver = jest.fn((_host, _opts, cb) => (addresses instanceof Error ? cb(addresses, []) : cb(null, addresses)));
      createGuardedLookup(resolver)('host.test', { family: 0 }, (err, result) => resolve({ err, result }));
      expect(resolver).toHaveBeenCalledWith('host.test', { family: 0, all: true }, expect.any(Function));
    });

  it('passes public addresses through in the shape axios expects', async () => {
    await expect(run([{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }])).resolves.toEqual({
      err: null,
      result: [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }]
    });
  });

  it('fails when any resolved address is internal', async () => {
    const { err } = await run([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]);
    expect(err?.message).toBe(INTERNAL_URL_ERROR);
  });

  it('passes resolver errors through', async () => {
    const { err } = await run(new Error('ENOTFOUND'));
    expect(err?.message).toBe('ENOTFOUND');
  });
});

describe('refuseInternalRedirect', () => {
  it('throws for a redirect to a literal internal host', () => {
    expect(() => refuseInternalRedirect({ hostname: '127.0.0.1' })).toThrow(INTERNAL_URL_ERROR);
    expect(() => refuseInternalRedirect({ hostname: '[::1]' })).toThrow(INTERNAL_URL_ERROR);
    expect(() => refuseInternalRedirect({ hostname: 'localhost' })).toThrow(INTERNAL_URL_ERROR);
  });

  it('allows a redirect to a public host', () => {
    expect(() => refuseInternalRedirect({ hostname: 'cdn.example.com' })).not.toThrow();
  });
});
