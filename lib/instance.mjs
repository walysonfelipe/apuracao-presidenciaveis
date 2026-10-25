import { createResults } from './results.mjs';

// One cache per server process, shared by routes and background workers, also across hot reloads.
export const getResults = () => (globalThis.presidentialResults ||= createResults());
