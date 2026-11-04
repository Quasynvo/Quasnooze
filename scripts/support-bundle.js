#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { prepareSupportBundle, writeSupportBundle } from '../src/support-bundle.js';

try {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) {
    console.log('quasnooze support-bundle [--snapshot FILE] [--telemetry FILE] [--out FILE --write]\nDefault: exact JSON preview only, no file created. --write requires an interactive SAVE confirmation after preview and a user-chosen destination. No upload, probes, personal export or automatic input discovery. See docs/SUPPORT-BUNDLE.md.');
  } else {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--write') { options.write = true; continue; }
      const field = { '--snapshot': 'snapshotPath', '--telemetry': 'telemetryPath', '--out': 'destination' }[args[i]];
      if (!field || !args[i + 1] || args[i + 1].startsWith('--') || options[field]) throw new Error('Invalid support options');
      options[field] = args[++i];
    }
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const preview = prepareSupportBundle({ snapshotPath: options.snapshotPath, telemetryPath: options.telemetryPath, appVersion: pkg.version });
    // Show the actual file bytes; confirmation never re-reads changing inputs.
    process.stdout.write(preview.text);
    console.error(`Preview only: ${preview.bytes} bytes; SHA-256 ${preview.sha256}. Review before sharing. No upload.`);
    if (options.write) {
      if (!options.destination || !process.stdin.isTTY) throw new Error('An interactive terminal and --out are required');
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      let answer;
      try { answer = await rl.question('Save exactly this preview to your chosen local destination? Type SAVE: '); }
      finally { rl.close(); }
      if (answer !== 'SAVE') throw new Error('Save cancelled');
      writeSupportBundle(preview, { destination: options.destination, confirmation: preview.sha256 });
      console.error('Saved locally. Review again before sharing; nothing was uploaded.');
    }
  }
} catch {
  console.error('Support bundle not saved successfully. Check options, confirmation and local permissions. Existing files are never overwritten; a partial new file may remain after a write error. No upload. See --help.');
  process.exitCode = 1;
}
