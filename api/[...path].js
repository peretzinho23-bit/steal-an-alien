// Kept for single-segment routes (/api/me, /api/health). Nested routes go through api/handler.js (see vercel.json).
export { default } from '../web/api/[...path].js';
