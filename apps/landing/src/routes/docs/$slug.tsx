import { createFileRoute, notFound } from '@tanstack/react-router';
import { RajioDocsPage } from '../../docs-page';
import { source } from '../../source';

export const Route = createFileRoute('/docs/$slug')({
  loader: ({ params }) => {
    if (!source.getPage([params.slug])) throw notFound();
  },
  head: ({ params }) => ({
    meta: [
      {
        title: `${source.getPage([params.slug])?.data.title ?? '页面不存在'} - Rajio`
      }
    ]
  }),
  component: DocsSlugPage
});

function DocsSlugPage() {
  const { slug } = Route.useParams();

  return <RajioDocsPage slugs={[slug]} />;
}
