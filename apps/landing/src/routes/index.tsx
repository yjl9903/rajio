import { Link, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: HomePage
});

function HomePage() {
  return (
    <main className="page">
      <section className="hero">
        <p>Japanese seiyuu radio translation workflow</p>
        <h1>Rajio</h1>
        <p>
          Turn long-form radio audio into reviewed transcripts, Chinese translations, and subtitle
          exports with a resumable TypeScript CLI.
        </p>
        <p>
          <Link to="/docs/$/slug" params={{ _splat: 'getting-started' }}>
            Read the docs
          </Link>
        </p>
      </section>
      <section className="card-grid" aria-label="Highlights">
        <article className="card">
          <h2>Resumable</h2>
          <p>Session state keeps long translation jobs restartable and auditable.</p>
        </article>
        <article className="card">
          <h2>Agent-ready</h2>
          <p>Manual review stages are structured for careful human or Codex edits.</p>
        </article>
        <article className="card">
          <h2>Subtitle-first</h2>
          <p>Validation focuses on transcript, translation, SRT, and ASS output quality.</p>
        </article>
      </section>
    </main>
  );
}
