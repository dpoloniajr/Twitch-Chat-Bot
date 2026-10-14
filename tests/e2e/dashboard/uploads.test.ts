/**
 * Characterization: dashboard/routes/uploads.js (mounted at /api/uploads) and the /uploads static files
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import * as path from 'path';
import { startDashboard, silenceConsole, Dash } from './helpers';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0])]);

const b64 = (buf: Buffer) => buf.toString('base64');

describe('dashboard /api/uploads', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard();
  });
  afterEach(async () => {
    await d.close();
  });

  it('init() creates the upload folders', () => {
    for (const sub of ['images', 'videos', 'sounds']) {
      expect(fs.statSync(path.join(d.uploadsDir, sub)).isDirectory()).toBe(true);
    }
  });

  describe('POST /image|/video|/sound', () => {
    it('saves an image (data: URI prefix stripped) and serves it from /uploads', async () => {
      const res = await d.post('/api/uploads/image', { data: `data:image/png;base64,${b64(PNG)}`, filename: 'My Pic!.PNG' });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        success: true,
        filename: expect.stringMatching(/^[0-9a-f]{16}_My_Pic_\.PNG$/),
        path: expect.stringMatching(/^\/uploads\/images\/[0-9a-f]{16}_My_Pic_\.PNG$/),
        size: PNG.length,
        type: 'image'
      });
      const saved = fs.readFileSync(path.join(d.uploadsDir, 'images', res.json.filename));
      expect(saved.equals(PNG)).toBe(true);
      const served = await d.get(res.json.path);
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe('image/png');
    });

    it('accepts other valid formats in their folders', async () => {
      expect((await d.post('/api/uploads/sound', { data: b64(WAV), filename: 'a.wav' })).json.path).toMatch(/^\/uploads\/sounds\//);
      expect((await d.post('/api/uploads/sound', { data: b64(MP3), filename: 'a.mp3' })).status).toBe(200);
      expect((await d.post('/api/uploads/image', { data: b64(WEBP), filename: 'a.webp' })).status).toBe(200);
      expect((await d.post('/api/uploads/video', { data: b64(MP4), filename: 'a.mp4' })).json.path).toMatch(/^\/uploads\/videos\//);
      expect(fs.readdirSync(path.join(d.uploadsDir, 'sounds'))).toHaveLength(2);
    });

    it('rejects a disallowed extension with 415', async () => {
      const res = await d.post('/api/uploads/image', { data: b64(PNG), filename: 'a.exe' });
      expect(res.status).toBe(415);
      expect(res.json).toEqual({ success: false, error: 'Invalid file type. Allowed: .png, .jpg, .jpeg, .gif, .webp' });
      const wrongFolder = await d.post('/api/uploads/sound', { data: b64(PNG), filename: 'a.png' });
      expect(wrongFolder.status).toBe(415);
    });

    it('rejects content that does not match the extension with 415', async () => {
      const res = await d.post('/api/uploads/image', { data: b64(Buffer.from('not a png at all')), filename: 'a.png' });
      expect(res.status).toBe(415);
      expect(res.json).toEqual({ success: false, error: 'File content does not match .png format.' });
      const wavAsWebp = await d.post('/api/uploads/image', { data: b64(WAV), filename: 'a.webp' });
      expect(wavAsWebp.status).toBe(415);
      expect(fs.readdirSync(path.join(d.uploadsDir, 'images'))).toEqual([]);
    });

    it('validates data and filename', async () => {
      const res = await d.post('/api/uploads/image', { filename: 'a.png' });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ success: false, error: 'data is required' });
      const res2 = await d.post('/api/uploads/image', { data: b64(PNG) });
      expect(res2.status).toBe(400);
      expect(res2.json.error).toBe('filename is required');
    });

    it('rejects files over 10MB with 413', async () => {
      const big = Buffer.alloc(10 * 1024 * 1024 + 1);
      PNG.copy(big);
      const res = await d.post('/api/uploads/image', { data: b64(big), filename: 'big.png' }, { timeoutMs: 20000 });
      expect(res.status).toBe(413);
      expect(res.json).toEqual({ success: false, error: 'File size exceeds 10MB limit' });
    }, 20000);

    it('rate-limits to 10 attempts per minute per IP, counting failed attempts', async () => {
      for (let i = 0; i < 10; i++) {
        expect((await d.post('/api/uploads/image', { data: b64(PNG), filename: 'a.exe' })).status).toBe(415);
      }
      const res = await d.post('/api/uploads/image', { data: b64(PNG), filename: 'ok.png' });
      expect(res.status).toBe(429);
      expect(res.json).toEqual({ success: false, error: 'Rate limit exceeded' });
      // validation errors happen before the rate-limit check and are not counted
      expect((await d.post('/api/uploads/sound', { filename: 'a.mp3' })).status).toBe(400);
    });
  });

  describe('GET /:mediaType', () => {
    it('lists uploaded files', async () => {
      const up = await d.post('/api/uploads/image', { data: b64(PNG), filename: 'a.png' });
      const res = await d.get('/api/uploads/images');
      expect(res.json).toEqual({
        success: true,
        files: [{ filename: up.json.filename, path: `/uploads/images/${up.json.filename}`, size: PNG.length, modified: expect.any(String) }]
      });
      expect((await d.get('/api/uploads/sounds')).json).toEqual({ success: true, files: [] });
    });

    it('rejects unknown media types with 400', async () => {
      const res = await d.get('/api/uploads/image');
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ success: false, error: 'Invalid media type' });
    });
  });

  describe('DELETE /:mediaType/:filename', () => {
    it('deletes an uploaded file; 404 when missing', async () => {
      const up = await d.post('/api/uploads/image', { data: b64(PNG), filename: 'a.png' });
      const res = await d.del(`/api/uploads/images/${up.json.filename}`);
      expect(res.json).toEqual({ success: true, deleted: up.json.filename });
      expect(fs.readdirSync(path.join(d.uploadsDir, 'images'))).toEqual([]);
      const again = await d.del(`/api/uploads/images/${up.json.filename}`);
      expect(again.status).toBe(404);
      expect(again.json).toEqual({ success: false, error: 'File not found' });
    });

    it.each([
      ['an encoded ".." media type', '/api/uploads/%2E%2E/sentinel.txt', 'Invalid media type'],
      ['an encoded "../logs" media type', '/api/uploads/..%2Flogs/commands.json', 'Invalid media type'],
      ['an unknown media type', '/api/uploads/docs/x.png', 'Invalid media type'],
      ['an encoded "../" in the file name', '/api/uploads/images/..%2F..%2Flogs%2Fcommands.json', 'Invalid filename'],
      ['an encoded backslash path', '/api/uploads/images/..%5C..%5Csentinel.txt', 'Invalid filename'],
      ['a ".." file name', '/api/uploads/images/%2E%2E', 'Invalid filename']
    ])('rejects %s with 400 and deletes nothing (path traversal)', async (_label, url, error) => {
      fs.writeFileSync(path.join(d.root, 'sentinel.txt'), 'x');
      const res = await d.del(url);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ success: false, error });
      expect(fs.existsSync(path.join(d.root, 'sentinel.txt'))).toBe(true);
      expect(d.exists('commands.json')).toBe(true);
    });
  });
});
