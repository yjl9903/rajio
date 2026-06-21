import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { docsPages } from '../source';

type SiteEnv = Partial<Record<'SITE_URL' | 'PUBLIC_SITE_URL' | 'URL', string>>;

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => {
        const siteEnv = env as SiteEnv;
        const configuredOrigin = siteEnv.SITE_URL ?? siteEnv.PUBLIC_SITE_URL ?? siteEnv.URL;
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
