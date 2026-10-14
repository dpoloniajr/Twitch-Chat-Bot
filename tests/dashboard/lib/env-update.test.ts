/**
 * Tests for the .env writer used by PUT /api/config (src/dashboard/lib/utils.ts):
 * formatEnvValue() quoting and updateEnvValues() editing. Every written value is
 * read back with both dotenv (what the bot uses) and readEnvFileSync (what the
 * dashboard uses), so a value the Settings page saves reaches the bot unchanged.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { formatEnvValue, readEnvFileSync, updateEnvValues, ValidationError } from '../../../src/dashboard/lib/utils';

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-update-'));
  envPath = path.join(dir, '.env');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = () => fs.readFileSync(envPath, 'utf8');

describe('formatEnvValue', () => {
  it.each([
    ['plain', 'hello', 'hello'],
    ['empty', '', ''],
    ['inner spaces', 'Chat is HYPED', 'Chat is HYPED'],
    ['unicode', 'Welcome 🔥 {user}!', 'Welcome 🔥 {user}!'],
    ['equals and pipes', 'a=b|c', 'a=b|c'],
    ['hash', 'Chat is #1', "'Chat is #1'"],
    ['double quotes', 'say "hi"', `'say "hi"'`],
    ['backtick', 'a`b', "'a`b'"],
    ['leading space', ' padded', "' padded'"],
    ['trailing space', 'padded ', "'padded '"],
    ['single quote', "it's", `"it's"`],
    ['backslash alone', 'C:\\path', 'C:\\path']
  ])('%s', (_label, value, expected) => {
    expect(formatEnvValue('K', value)).toBe(expected);
  });

  it.each([
    ['line feed', 'a\nb'],
    ['carriage return', 'a\rb'],
    ['NUL', 'a\u0000b'],
    ['both quote kinds', `it's "x"`],
    ['single quote and backslash', "it's \\n"]
  ])('rejects %s', (_label, value) => {
    expect(() => formatEnvValue('K', value)).toThrow(ValidationError);
  });

  it.each([
    'hello', 'Chat is #1', 'say "hi"', "it's", ' padded ', 'a`b', '#', "'", '"', 'x # y', 'C:\\path', 'a=b'
  ])('round-trips %p through dotenv and readEnvFileSync', value => {
    const line = `K=${formatEnvValue('K', value)}\n`;
    expect(dotenv.parse(line).K).toBe(value);
    fs.writeFileSync(envPath, line);
    expect(readEnvFileSync(envPath).K).toBe(value);
  });
});

describe('updateEnvValues', () => {
  it('creates a missing file', async () => {
    await updateEnvValues(envPath, { A: '1', B: 'two' });
    expect(read()).toBe('A=1\nB=two\n');
  });

  it('writes nothing but an empty file when only removing from a missing file', async () => {
    await updateEnvValues(envPath, { A: null });
    expect(read()).toBe('');
  });

  it('replaces in place and keeps comments, blank lines and other keys', async () => {
    fs.writeFileSync(envPath, '# Twitch\nTWITCH_CLIENT_ID=old\n\nOTHER=keep # note\nHYPE_ENABLED=true\n');
    await updateEnvValues(envPath, { TWITCH_CLIENT_ID: 'new', HYPE_ENABLED: 'false' });
    expect(read()).toBe('# Twitch\nTWITCH_CLIENT_ID=new\n\nOTHER=keep # note\nHYPE_ENABLED=false\n');
  });

  it('appends keys that are not in the file yet', async () => {
    fs.writeFileSync(envPath, 'A=1');
    await updateEnvValues(envPath, { B: '2' });
    expect(read()).toBe('A=1\nB=2\n');
  });

  it('removes every line of a key set to null', async () => {
    fs.writeFileSync(envPath, 'A=1\nB=2\nA=3\nC=4\n');
    await updateEnvValues(envPath, { A: null });
    expect(read()).toBe('B=2\nC=4\n');
  });

  it('collapses duplicate lines into the first one', async () => {
    fs.writeFileSync(envPath, 'A=1\nB=2\nA=3\n');
    await updateEnvValues(envPath, { A: 'x' });
    expect(read()).toBe('A=x\nB=2\n');
    expect(dotenv.parse(read()).A).toBe('x');
  });

  it('matches `export KEY=` and spaced `KEY = value` lines', async () => {
    fs.writeFileSync(envPath, 'export A=1\nB = 2\n');
    await updateEnvValues(envPath, { A: 'x', B: 'y' });
    expect(read()).toBe('A=x\nB=y\n');
  });

  it('does not touch keys that only share a prefix', async () => {
    fs.writeFileSync(envPath, 'HYPE_ENABLED_OLD=1\nHYPE=2\n');
    await updateEnvValues(envPath, { HYPE_ENABLED: 'true' });
    expect(read()).toBe('HYPE_ENABLED_OLD=1\nHYPE=2\nHYPE_ENABLED=true\n');
  });

  it('ignores commented-out lines for the key', async () => {
    fs.writeFileSync(envPath, '# A=old\n');
    await updateEnvValues(envPath, { A: 'new' });
    expect(read()).toBe('# A=old\nA=new\n');
  });

  it('keeps Windows line endings', async () => {
    fs.writeFileSync(envPath, 'A=1\r\nB=2\r\n');
    await updateEnvValues(envPath, { A: 'x', C: '3' });
    expect(read()).toBe('A=x\r\nB=2\r\nC=3\r\n');
  });

  it('quotes values that need it so dotenv reads them back', async () => {
    await updateEnvValues(envPath, { HYPE_MESSAGE: 'Chat is #1 "hype"', FIRST_CHATTER_MESSAGE: "Welcome, it's {user}" });
    const parsed = dotenv.parse(read());
    expect(parsed.HYPE_MESSAGE).toBe('Chat is #1 "hype"');
    expect(parsed.FIRST_CHATTER_MESSAGE).toBe("Welcome, it's {user}");
  });

  it('is all-or-nothing: an invalid value or key leaves the file untouched', async () => {
    fs.writeFileSync(envPath, 'A=1\n');
    await expect(updateEnvValues(envPath, { A: '2', B: 'bad\nline' })).rejects.toThrow(ValidationError);
    await expect(updateEnvValues(envPath, { A: '2', 'BAD-KEY': 'x' })).rejects.toThrow('Invalid .env key');
    await expect(updateEnvValues(envPath, { A: '2', '1A': 'x' })).rejects.toThrow('Invalid .env key');
    expect(read()).toBe('A=1\n');
  });

  it('treats inherited object property names as ordinary keys', async () => {
    fs.writeFileSync(envPath, 'constructor=1\ntoString=2\n');
    await updateEnvValues(envPath, { A: 'x' });
    expect(read()).toBe('constructor=1\ntoString=2\nA=x\n');
  });

  it('keeps the file permissions (written in place, not replaced)', async () => {
    if (process.platform === 'win32') return;
    fs.writeFileSync(envPath, 'A=1\n');
    fs.chmodSync(envPath, 0o600);
    const inode = fs.statSync(envPath).ino;
    await updateEnvValues(envPath, { A: '2' });
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(envPath).ino).toBe(inode);
  });

  it('serializes concurrent edits so none is lost', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => updateEnvValues(envPath, { [`K${i}`]: String(i) })));
    const parsed = dotenv.parse(read());
    for (let i = 0; i < 10; i++) expect(parsed[`K${i}`]).toBe(String(i));
  });
});
