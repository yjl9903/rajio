import { createFileRoute } from '@tanstack/react-router';
import { RajioDocsPage } from '../../docs-page';

export const Route = createFileRoute('/docs/$slug')({
  component: DocsSlugPage
});

function DocsSlugPage() {
  const { slug } = Route.useParams();

  return <RajioDocsPage slugs={[slug]} />;
}
