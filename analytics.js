// HeyCatch analytics — client init (https://heycatch.ai/agents.md).
// Loaded as a module from <head> on every page; module scope, static import,
// idempotent init. The project key is publishable by design.
import { analytics } from 'https://esm.sh/@heycatch/sdk@0.8.3';

analytics.init({
  projectKey: 'hck_pk_Ytw7NVIoMAahVhRRPN0UCxwmyuLEo70-',
  install: {
    framework: 'web',
    agent: 'other',
  },
});

// Classic scripts (app.js) reach the SDK through this global; module
// consumers can import { analytics } directly.
window.PDLAnalytics = analytics;

export { analytics };
