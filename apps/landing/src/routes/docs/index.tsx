import { createFileRoute } from '@tanstack/react-router';
import { RajioDocsPage } from '../../docs-page';

export const Route = createFileRoute('/docs/')({
  component: DocsIndexPage
});

function DocsIndexPage() {
  return <RajioDocsPage />;
}
