// Single function that receives every /api request. vercel.json rewrites /api/<path> here with the path in
// "__path", because Vercel's catch-all route does not match nested paths like /api/auth/login on this project.
// The shared handler in web/ expects the original URL, so it is put back before the request is passed on.
import handler from '../web/api/[...path].js';

export default function apiEntry(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.searchParams.get('__path') ?? '';
  url.searchParams.delete('__path');
  const query = url.searchParams.toString();
  req.url = `/api/${path}${query ? `?${query}` : ''}`;
  return handler(req, res);
}
