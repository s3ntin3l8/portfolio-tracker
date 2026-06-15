// Test stub for the `server-only` guard module so server-side lib code (server-api.ts)
// can be imported under the jsdom test environment. The real package throws when bundled
// for the client; in tests we just want an inert module.
export {};
