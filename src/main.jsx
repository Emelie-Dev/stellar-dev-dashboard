import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/globals.css";
import { initPerformanceMonitoring } from "./lib/performance";
import { selfHealingManager } from "./lib/errorHandling/SelfHealingManager";
import { registerBuiltInStrategies, registerNetworkProbes } from "./lib/errorHandling/RecoveryStrategyRegistry";

// Initialize performance monitoring (no RUM endpoint by default)
initPerformanceMonitoring();

// D-057 — Bootstrap error recovery & self-healing
registerBuiltInStrategies();
registerNetworkProbes().then(() => {
  selfHealingManager.start();
}).catch(() => {
  // Non-critical: app continues without self-healing probes
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// Register the service worker after the app has mounted.
// Using window.load ensures the SW registration doesn't compete with initial
// resource fetching and slowing the first paint.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    registerServiceWorker();
  });
}
