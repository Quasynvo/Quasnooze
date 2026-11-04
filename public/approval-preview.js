/** Plain text only. Callers assign the result with textContent, never innerHTML. */
globalThis.approvalPreviewText = function (preview) {
  if (!preview || typeof preview !== 'object') return '';
  const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : 'unknown';
  return [
    'Tool/action: ' + text(preview.tool, 80) + ' / ' + text(preview.action, 80),
    'Target: ' + text(preview.target, 240),
    'Risk: ' + text(preview.riskRationale, 320),
    'Expected effect: ' + text(preview.effectSummary, 320),
    'Preview: ' + (preview.status === 'supported' ? 'supported' : 'unknown'),
    'Redactions: ' + (Array.isArray(preview.redactions) && preview.redactions.length ? preview.redactions.slice(0, 8).map(v => text(v, 48)).join(', ') : 'none detected (not a guarantee)'),
  ].join('\n');
};
