// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: 'e2e.spec.js',
  timeout: 120000,
  expect: {
    timeout: 15000
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  }
});
