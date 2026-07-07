export * from './types.js';
export { ClaudeCodeAdapter } from './sources/claude-code.js';
export { CursorAdapter } from './sources/cursor.js';
export { discoverAll, observeProject, getAdapters } from './engine.js';
export { buildSignals } from './cluster.js';
export { distill } from './distill.js';
export { findStaleReferences } from './stale.js';
export {
  applyToFile,
  loadProposals,
  readExistingContext,
  renderProposalPreview,
  saveProposals,
} from './propose.js';
