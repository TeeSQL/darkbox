import { initPlatform } from "./platform/telegram.js";

/**
 * Root Preact component.
 *
 * Step 1 of the migration: the Preact runtime + Signals store are mounted and
 * building, but no view has been ported yet — so this renders nothing visible.
 * Subsequent steps replace the legacy flow.js screens with components here
 * (Leaderboard, Markets, DaemonReveal, MicComposer, …).
 */
export function App() {
  initPlatform();
  return null;
}
