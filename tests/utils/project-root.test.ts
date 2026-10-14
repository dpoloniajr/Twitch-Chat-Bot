import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findProjectRoot, projectPath } from '../../src/utils/project-root';

describe('project root', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-root-')));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds the repository root from the source tree', () => {
    expect(findProjectRoot()).toBe(repoRoot);
  });

  it('finds the root from a nested folder such as dist/', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const nested = path.join(dir, 'dist', 'src', 'utils');
    fs.mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(dir);
  });

  it('returns the start folder when it holds package.json', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(findProjectRoot(dir)).toBe(dir);
  });

  it('stops at the nearest package.json', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const inner = path.join(dir, 'packages', 'inner');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'package.json'), '{}');
    expect(findProjectRoot(path.join(inner, 'lib'))).toBe(inner);
  });

  it('resolves relative start paths', () => {
    expect(findProjectRoot(path.relative(process.cwd(), path.join(repoRoot, 'src')))).toBe(repoRoot);
  });

  it('throws when no package.json exists above the folder', () => {
    // Precondition: nothing above the temp folder is a project
    for (let d = dir; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, 'package.json'))) return;
      if (path.dirname(d) === d) break;
    }
    expect(() => findProjectRoot(path.join(dir, 'nowhere'))).toThrow(/No package.json found above/);
  });

  it('joins segments onto the root', () => {
    expect(projectPath('dashboard', 'logs')).toBe(path.join(repoRoot, 'dashboard', 'logs'));
    expect(projectPath()).toBe(repoRoot);
  });
});
