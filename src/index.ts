export * from './types.js';
export { ClaudeCodeAdapter } from './sources/claude-code.js';
export { buildSignals } from './cluster.js';
export { distill } from './distill.js';
export {
  applyToFile,
  loadProposals,
  readExistingContext,
  renderProposalPreview,
  saveProposals,
} from './propose.js';
