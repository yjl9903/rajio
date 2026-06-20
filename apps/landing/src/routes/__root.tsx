import { Link, Outlet, createRootRoute } from '@tanstack/react-router';
import '../styles.css';

export const Route = createRootRoute({
  component: RootLayout
});

function RootLayout() {
  return (
    <>
      <header className="page" style={{ paddingBottom: 0 }}>
        <nav style={{ display: 'flex', gap: 16 }}>
          <Link to="/">Home</Link>
          <Link to="/docs/$/slug" params={{ _splat: 'getting-started' }}>
            Docs
          </Link>
        </nav>
      </header>
      <Outlet />
    </>
  );
}
