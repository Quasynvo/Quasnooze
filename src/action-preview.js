/** Display-only, ephemeral approval metadata. Never used to authorize/execute a tool. */
export const PREVIEW_LIMITS = Object.freeze({ tool: 80, action: 80, target: 240, riskRationale: 320, effectSummary: 320 });

export function redactPreviewText(value, secrets = []) {
  let text = String(value ?? '').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ');
  for (const secret of [...secrets].filter(v => typeof v === 'string' && v.length >= 4).sort((a, b) => b.length - a.length)) {
    for (const form of new Set([secret, encodeURIComponent(secret)])) text = text.split(form).join('[REDACTED]');
  }
  return text
    .replace(/\b(?:Bearer\s+)[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:[\w-]*(?:token|secret|password|api[_-]?key|authorization)[\w-]*)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,})\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function approvalDescription(value, secrets = []) {
  const text = redactPreviewText(value, secrets);
  return text.length > 2000 ? text.slice(0, 1900) + '… [description truncated; inspect the full request before allowing]' : text;
}

export function previewSecrets(env = process.env) {
  return Object.entries(env).filter(([key]) => /(?:key|token|secret|password|credential)/i.test(key)).map(([, value]) => value);
}

export function sanitizeActionPreview(input = {}, secrets = []) {
  const redactions = new Set();
  const out = { version: 1, status: input.status === 'supported' ? 'supported' : 'unknown' };
  for (const [field, limit] of Object.entries(PREVIEW_LIMITS)) {
    const original = typeof input[field] === 'string' ? input[field] : 'unknown';
    const redacted = redactPreviewText(original, secrets);
    if (original !== redacted) redactions.add('sensitive-or-control-text');
    if (redacted.length > limit) redactions.add('truncated');
    out[field] = redacted.length > limit ? redacted.slice(0, limit - 1) + '…' : redacted;
  }
  // Only fixed reason codes may cross the contract, never arbitrary redaction text.
  for (const reason of Array.isArray(input.redactions) ? input.redactions : []) {
    if (['sensitive-or-control-text', 'truncated', 'command-withheld', 'content-withheld', 'url-details-withheld', 'unsupported-arguments-withheld'].includes(reason)) redactions.add(reason);
  }
  out.redactions = Object.freeze([...redactions]);
  return Object.freeze(out);
}

export function buildActionPreview(name, args = {}, { risk, preparation, secrets = previewSecrets() } = {}) {
  const preview = { tool: name, action: name, target: 'unknown', status: 'supported',
    riskRationale: 'This tool requires explicit approval under the current tool policy.',
    effectSummary: 'unknown — no supported effect preview is available.', redactions: [] };
  switch (name) {
    case 'shell':
      preview.target = args.cwd || 'default workspace working directory (not a resolved path)';
      preview.riskRationale = risk?.tier === 'act'
        ? 'Command is not classified as read-only. Shell execution may change files, run programs or contact services.'
        : 'Shell execution requires approval and can change files, run programs or contact services; exact effects are unknown.';
      preview.effectSummary = 'Execute the separately described shell command. Exact targets and side effects are unknown; this is not a dry run.';
      preview.redactions.push('command-withheld'); break;
    case 'write_file':
      preview.target = args.path || 'unknown';
      preview.effectSummary = `Create or replace this file with ${Buffer.byteLength(String(args.content || ''), 'utf8')} bytes. Parent folders may be created. Contents are withheld.`;
      preview.redactions.push('content-withheld'); break;
    case 'move_path':
    case 'rename_path':
    case 'trash_path': {
      // The whole plan, before it runs: every operation the approval covers
      // is named here, because an approval that shows one item of N is not
      // an approval of the batch (issue #129).
      const ops = Array.isArray(args.operations) ? args.operations : [];
      const describeOp = (op) =>
        name === 'move_path' ? `${op?.from ?? '?'} → ${op?.to ?? '?'}`
        : name === 'rename_path' ? `${op?.path ?? '?'} → ${op?.new_name ?? '?'}`
        : String(op?.path ?? '?');
      const shown = ops.slice(0, 4).map(describeOp).join('; ');
      const more = ops.length > 4 ? ` (+${ops.length - 4} more)` : '';
      preview.action = name;
      preview.target = ops.length === 1 ? describeOp(ops[0]) : `${ops.length} operations (each listed below)`;
      if (name === 'move_path') {
        preview.riskRationale = 'Moving files changes where they live; this exact plan runs only after you approve it. Cross-root moves are refused; an existing destination needs the explicit overwrite flag.';
        preview.effectSummary = `Move ${ops.length} item(s) inside the workspace: ${shown}${more}. Nothing is deleted (an overwritten destination goes to the local trash first); every operation is journaled and undo_last reverses this batch.`;
      } else if (name === 'rename_path') {
        preview.riskRationale = 'Renaming changes the name other files reference; this exact plan runs only after you approve it. An existing destination needs the explicit overwrite flag.';
        preview.effectSummary = `Rename ${ops.length} item(s) in place: ${shown}${more}. Nothing is deleted (an overwritten destination is trashed first); every operation is journaled and undo_last reverses this batch.`;
      } else {
        preview.riskRationale = 'Trashing moves files out of sight without deleting them; approval shows every path, and undo_last restores them.';
        preview.effectSummary = `Move ${ops.length} item(s) to the local .quasnooze-trash directory: ${shown}${more}. Never deleted — the bytes stay on disk, the journal records the move, and undo_last restores every original path.`;
      }
      break;
    }
    case 'undo_last':
      preview.action = 'undo_last';
      preview.target = 'most recent file-action batch';
      preview.riskRationale = 'Undo renames files back to their original paths. It reverses only what the journal recorded and reports anything it cannot restore.';
      preview.effectSummary = 'Reverse the newest file-action batch: rename every applied move, rename or trash back to its original path, newest first. Reports exactly what was restored; changes nothing else.';
      break;
    case 'list_recent_changes':
      preview.action = 'list_recent_changes';
      preview.target = 'file-action journal';
      preview.riskRationale = 'Read-only: this reads the local journal and changes nothing.';
      preview.effectSummary = 'List recent move, rename, trash and undo journal entries with source, destination, timestamp and status. Read-only.';
      break;
    case 'open_url':
      try { const url = new URL(args.url); preview.target = url.origin + url.pathname; }
      catch { preview.target = 'unknown'; }
      preview.effectSummary = 'Ask the operating system to open this URL in the default browser. Query, fragment and credentials are withheld.';
      preview.redactions.push('url-details-withheld'); break;
    case 'screenshot':
      preview.target = args.path || 'generated screenshot path (not yet resolved)';
      preview.effectSummary = 'Capture the screen and save an image. Visible personal information may be included.'; break;
    case 'system_control': {
      const machine = ['lock', 'sleep'];
      const media = ['volume_up', 'volume_down', 'set_volume', 'mute', 'unmute', 'media_play_pause', 'media_next', 'media_previous'];
      preview.action = [...machine, ...media].includes(args.action) ? args.action : 'unknown';
      preview.target = 'local computer';
      if (preview.action === 'unknown') preview.effectSummary = 'unknown';
      else if (machine.includes(preview.action)) preview.effectSummary = `Request ${preview.action} from the operating system. Running work may be interrupted.`;
      else if (preview.action === 'set_volume') {
        const bounded = Number.isInteger(args.level) && args.level >= 0 && args.level <= 100;
        preview.effectSummary = `Set system volume to ${bounded ? `${args.level}%` : 'an invalid level (will be rejected)'} via the Windows companion. Reversible; touches no files.`;
      }
      else preview.effectSummary = `Send ${preview.action.replace(/_/g, ' ')} to the Windows companion (Core Audio / media key). Reversible; touches no files.`;
      break;
    }
    case 'launch_app':
      preview.action = 'launch_app';
      preview.target = String(args.name ?? 'unknown');
      preview.effectSummary = 'Start the executable registered under this exact plain name (companion built-in list or the user\'s own %APPDATA%\\Quasnooze\\apps.json) with no arguments and no shell. Unknown names are refused.';
      break;
    case 'close_window':
      preview.action = 'close_window';
      preview.target = String(args.name ?? 'unknown');
      preview.effectSummary = 'Close one uniquely matched window (WM_CLOSE) via the Windows companion, after a second native confirmation naming the application. Unsaved work in that window may be lost; ambiguous names change nothing.';
      break;
    case 'read_clipboard':
      preview.action = 'read_clipboard';
      preview.target = 'system clipboard';
      preview.riskRationale = 'Reading the clipboard is a privacy event: it may hold passwords, tokens or personal text. Approval applies to this single read only, never the session.';
      preview.effectSummary = 'Read up to 4,096 UTF-8 bytes of current clipboard text and report the original byte length. Secret-shaped content is refused; clipboard text is never written to telemetry, support bundles or default memory.';
      break;
    case 'write_clipboard': {
      preview.action = 'write_clipboard';
      preview.target = 'system clipboard';
      preview.riskRationale = 'Writing replaces whatever is currently on your clipboard and cannot be undone automatically. Review the exact text before allowing.';
      if (typeof args.text === 'string' && args.text.length > 0) {
        const bytes = Buffer.byteLength(args.text, 'utf8');
        preview.effectSummary = `Overwrite the system clipboard with ${bytes} UTF-8 byte${bytes === 1 ? '' : 's'}: ${JSON.stringify(args.text)}`;
      } else {
        preview.effectSummary = 'Overwrite the system clipboard with invalid or empty text (will be rejected).';
      }
      break;
    }
    case 'type_text': {
      const text = String(args.text ?? '');
      const escaped = JSON.stringify(text).slice(1, -1);
      const shown = escaped.length > 140 ? escaped.slice(0, 140) + '…' : escaped;
      preview.action = 'type_text';
      preview.target = preparation?.target
        ? `${preparation.target.title} — ${preparation.target.process}`
        : 'foreground window (dry run unavailable)';
      preview.riskRationale = 'Keystrokes can submit forms, send messages or trigger shortcuts. This exact target needs fresh approval; password fields are refused.';
      preview.effectSummary = preparation?.target
        ? `Text (${text.length} UTF-16 characters total): ${shown}\nKeystrokes: ${preparation.keystrokes}; per-character delay: ${preparation.delayMs} ms. Dry run sent nothing.`
        : 'No keystrokes have been sent. A native dry run is required before approval.';
      break;
    }
    default:
      preview.status = 'unknown'; preview.redactions.push('unsupported-arguments-withheld');
  }
  return sanitizeActionPreview(preview, secrets);
}

export function formatActionPreview(preview) {
  if (!preview) return '';
  return `Tool/action: ${preview.tool} / ${preview.action}\nTarget: ${preview.target}\nRisk: ${preview.riskRationale}\nExpected effect: ${preview.effectSummary}\nPreview: ${preview.status}\nRedactions: ${preview.redactions.join(', ') || 'none detected (not a guarantee)'}`;
}
