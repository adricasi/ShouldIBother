import "./zod-config.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Self-hosted fonts (design-handoff §3; SIL OFL): Vite bundles the Latin files from the
// @fontsource packages, so the app makes no request to a font CDN.
import "@fontsource/big-shoulders-display/latin-800";
import "@fontsource/big-shoulders-display/latin-900";
import "@fontsource/figtree/latin-400.css";
import "@fontsource/figtree/latin-600.css";
import "@fontsource/figtree/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";

// The shared stylesheet comes first: the stylesheets beside each screen build on it and win ties.
import "./styles.css";
import { App } from "./App.js";
// Last: the wide-screen layout overrides what the screens above set for a phone.
import "./desktop.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root element");
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
