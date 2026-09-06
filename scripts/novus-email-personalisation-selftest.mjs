#!/usr/bin/env node

// Compatibility entrypoint. The active email contract is the evidence-led,
// two-field Diagnosis + Personalisation v2 contract exercised here.
await import('./novus-diagnosis-personalisation-v2-selftest.mjs');
