// Vercel only runs functions from the /api folder of the project root, so this file hands the request
// to the real handler in web/. Keep the logic in web/api/[...path].js.
export { default } from '../web/api/[...path].js';
