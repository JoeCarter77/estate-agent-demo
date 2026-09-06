#!/usr/bin/env node

// Compatibility entrypoint. The retired three-field/second-hook contract must
// not remain as a competing definition of valid Personalisation output.
await import('./novus-diagnosis-personalisation-v2-selftest.mjs');
