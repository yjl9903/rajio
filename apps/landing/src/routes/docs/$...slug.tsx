import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/docs/$/slug')({
  component: DocsPage
});

function DocsPage() {
  const { _splat } = Route.useParams();
  const title = _splat === 'getting-started' ? 'Getting Started' : 'Rajio Docs';

  return (
    <main className="page">
      <p>Docs</p>
      <h1>{title}</h1>
      <p>
        Fuma Docs content lives in <code>content/docs</code>. This route is ready to be wired to the
        generated source as the landing app grows.
      </p>
    </main>
  );
}
