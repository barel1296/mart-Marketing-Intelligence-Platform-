import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiGet, ApiError } from '../../lib/api';
import { SignOutButton } from '../../components/actions';

type Me = {
  user: { id: string; email: string; displayName: string };
  organizations: Array<{ id: string; name: string; slug: string; role: string }>;
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let me: Me;
  try {
    me = await apiGet<Me>('/api/v1/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect('/login');
    throw error;
  }

  const organization = me.organizations[0];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>MART</strong>
          <span>Phase 0A</span>
        </div>

        <nav className="nav-group">
          <span className="nav-label">Workspace</span>
          <Link className="nav-item" href="/apps">
            Apps
          </Link>
        </nav>

        <div style={{ marginTop: 'auto' }} className="stack">
          <div className="inline-meta" style={{ flexDirection: 'column', gap: 2 }}>
            <span style={{ color: 'var(--text-secondary)' }}>
              {organization?.name ?? 'No organization'}
            </span>
            <span>{me.user.email}</span>
            {organization ? <span>role: {organization.role}</span> : null}
          </div>
          <SignOutButton />
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
