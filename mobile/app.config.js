// The browser demo is served from GitHub Pages under /Nagrik/demo/app (see scripts/build-web-demo.mjs).
// Only that build gets the base URL, so the Android app and the dev server are unchanged.
module.exports = ({ config }) =>
  process.env.NAGRIK_WEB_DEMO === '1' ? { ...config, experiments: { ...config.experiments, baseUrl: '/Nagrik/demo/app' } } : config;
