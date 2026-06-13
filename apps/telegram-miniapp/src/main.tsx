import { render } from "preact";
import { App } from "./app.js";

/**
 * Preact entry point. Mounts into #app-root, which lives alongside the legacy
 * markup during the migration. Until views are ported, <App/> renders nothing,
 * so the existing flow.js UI is unaffected.
 */
const root = document.getElementById("app-root");
if (root) render(<App />, root);
