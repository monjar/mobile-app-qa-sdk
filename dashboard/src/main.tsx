import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import './styles.css';
import { AuthProvider, useAuth } from './lib/auth';
import { ApiError } from './lib/api';
import { ToastProvider } from './components/ui';
import { Layout } from './components/Layout';
import { Login, SetPassword, Setup } from './pages/Login';
import { Inbox } from './pages/Inbox';
import { Ticket } from './pages/Ticket';
import { ProjectSettings } from './pages/ProjectSettings';
import { Devices } from './pages/Devices';
import { Team } from './pages/Team';
import { Jobs } from './pages/Jobs';
import { NewProject } from './pages/NewProject';
import { Tokens } from './pages/Tokens';
import { Device } from './pages/Device';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
});

function App() {
  const { user, loading } = useAuth();
  const [location] = useLocation();
  const [newProject, setNewProject] = useState(false);
  if (loading) return null;
  if (location.startsWith('/setup')) return <Setup />;
  if (location.startsWith('/set-password')) return <SetPassword />;
  if (!user) return <Login />;
  return (
    <Layout onNewProject={() => setNewProject(true)}>
      <Switch>
        <Route path="/" component={Inbox} />
        <Route path="/tickets/:id">{(p) => <Ticket key={p.id} id={p.id} />}</Route>
        <Route path="/projects/:id/settings/:tab?">{(p) => <ProjectSettings id={p.id} tab={p.tab} />}</Route>
        <Route path="/projects/:id/devices">{(p) => <Devices key={p.id} id={p.id} />}</Route>
        {/* Where a failed GitHub sign-in lands; once signed in there's nothing to show there. */}
        <Route path="/login">
          <Redirect to="/" />
        </Route>
        <Route path="/tokens" component={Tokens} />
        {/* `snitch login` sends people here (/device?code=XXXX-XXXX); signing in first keeps the URL. */}
        <Route path="/device" component={Device} />
        <Route path="/team">{user.role === 'admin' ? <Team /> : <Redirect to="/" />}</Route>
        <Route path="/jobs">{user.role === 'admin' ? <Jobs /> : <Redirect to="/" />}</Route>
        <Route>
          <div className="page empty">Page not found.</div>
        </Route>
      </Switch>
      {newProject && <NewProject onClose={() => setNewProject(false)} />}
    </Layout>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
