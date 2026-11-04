/** Offline, copy-only migration. Never merge, follow symlinks, or remove originals. */
import * as fs from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export function previewMigration(root, destination) {
  const source = resolve(root), target = resolve(destination);
  if (source === target || target.startsWith(source + sep) || source.startsWith(target + sep)) {
    throw new Error('Migration source and destination must not overlap');
  }
  if (fs.existsSync(target)) throw new Error('Migration destination already exists; refusing to merge');
  const entries = ['.env', 'data'].filter(name => fs.existsSync(join(source, name)));
  if (!entries.length) throw new Error('No legacy state found');
  return { source, target, entries };
}

export function migrateState(root, destination, { confirmed = false, io = fs } = {}) {
  if (!confirmed) throw new Error('Preview and explicit confirmation required');
  const plan = previewMigration(root, destination);
  // Exclusive mkdir is the destination reservation: a competing migration cannot merge.
  io.mkdirSync(dirname(plan.target), { recursive: true, mode: 0o700 });
  io.mkdirSync(plan.target, { mode: 0o700 });
  try {
    io.writeFileSync(join(plan.target, '.migration-in-progress'), '', { flag: 'wx', mode: 0o600 });
    function copy(source, target) {
      const stat = io.lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error('Migration refuses symbolic links');
      if (stat.isDirectory()) {
        io.mkdirSync(target, { mode: 0o700 });
        for (const name of io.readdirSync(source)) copy(join(source, name), join(target, name));
      } else if (stat.isFile()) {
        io.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        io.chmodSync(target, 0o600);
      } else throw new Error('Migration refuses special files');
    }
    for (const name of plan.entries) copy(join(plan.source, name), join(plan.target, name));
    io.unlinkSync(join(plan.target, '.migration-in-progress'));
    return plan;
  } catch {
    // Originals are untouched even if cleanup fails (e.g. ACL denial).
    try { io.rmSync(plan.target, { recursive: true }); }
    catch { throw new Error('Migration failed; originals preserved. Destination cleanup needs owner attention.'); }
    throw new Error('Migration failed; originals preserved and destination rolled back');
  }
}
