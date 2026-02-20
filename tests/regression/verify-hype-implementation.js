/**
 * Verifies Chat Hype is fully implemented in Excella.js.
 * Run with: node tests/regression/verify-hype-implementation.js
 */
const fs = require('fs');
const path = require('path');

const excellaPath = path.join(__dirname, '../../Excella.js');
const content = fs.readFileSync(excellaPath, 'utf-8');
const lines = content.split('\n');

let passed = 0;
let failed = 0;

function ok(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

console.log('Chat Hype implementation verification\n');

ok('recordChatForHype is defined', /\bfunction\s+recordChatForHype\s*\(/.test(content));
ok('tryTriggerHype is defined', /\bfunction\s+tryTriggerHype\s*\(/.test(content));
ok('getHypeCount is defined', /\bfunction\s+getHypeCount\s*\(/.test(content));
ok('getHypeConfig is defined', /\bfunction\s+getHypeConfig\s*\(/.test(content));

const recordCallLine = lines.find((l) => l.includes('recordChatForHype(channel)') && !l.trim().startsWith('//'));
const triggerCallLine = lines.find((l) => l.includes('tryTriggerHype(channel)') && !l.trim().startsWith('//'));

ok('recordChatForHype(channel) is called (not commented)', !!recordCallLine);
ok('tryTriggerHype(channel) is called (not commented)', !!triggerCallLine);

ok('No TODO for incomplete hype feature', !content.includes('TODO: Incomplete feature - function implementations missing'));

console.log('\n' + (failed === 0 ? `${passed} checks passed.` : `${failed} check(s) failed.`));
process.exit(failed > 0 ? 1 : 0);
