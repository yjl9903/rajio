import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';
import { RootProvider } from 'fumadocs-ui/provider/tanstack';
import 'fumadocs-ui/style.css';
import '../styles.css';

export const Route = createRootRoute({
  component: RootLayout
});

function RootLayout() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <RootProvider>
          <Outlet />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
