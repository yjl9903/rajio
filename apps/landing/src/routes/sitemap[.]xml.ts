import { createFileRoute } from '@tanstack/react-router';
import { docsPages } from '../source';

const configuredOrigin = process.env.SITE_URL ?? process.env.PUBLIC_SITE_URL ?? process.env.URL;

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => {
        const baseUrl = normalizeOrigin(configuredOrigin ?? new URL(request.url).origin);
        const urls = ['/', ...docsPages.map((page) => page.url)];
        const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
          .map((url) => `  <url><loc>${baseUrl}${url}</loc></url>`)
          .join('\n')}\n</urlset>\n`;

        return new Response(body, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8'
          }
        });
      }
    }
  }
});

function normalizeOrigin(origin: string) {
  return origin.replace(/\/+$/, '');
}
