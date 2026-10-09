// The one serverless function behind every /api/* request (Vercel's free plan allows only 12 functions,
// so everything is routed inside lib/router.js instead of one file per endpoint).
import { createServices } from '../lib/context.js';
import { createHandler } from '../lib/router.js';

let services;
export default createHandler(() => (services ??= createServices()));
