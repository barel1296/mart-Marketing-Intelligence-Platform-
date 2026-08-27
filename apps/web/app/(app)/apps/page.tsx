import Link from 'next/link';
import { apiGet } from '../../../lib/api';
import { Card, EmptyState, StatusChip } from '../../../components/primitives';
import { CreateAppForm } from '../../../components/actions';

type Me = { organizations: Array<{ id: string; name: string; role: string }> };
type AppRow = {
  id: string;
  name: string;
  platform: string;
  bundle_id: string;
  timezone: string;
  default_currency: string;
  primary_attribution_provider: string | null;
};

export default async function AppsPage() {
  const me = await apiGet<Me>('/api/v1/auth/me');
  const organization = me.organizations[0];

  if (!organization) {
    return (
      <EmptyState
        title="No organization"
        message="Your user is not a member of any organization yet. Ask an owner to invite you."
      />
    );
  }

  const { apps } = await apiGet<{ apps: AppRow[] }>(
    `/api/v1/organizations/${organization.id}/apps`,
  );

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Apps</h1>
          <p>
            An app is the unit MART reports on. Each one connects to one marketing network and one
            primary attribution provider.
          </p>
        </div>
        <CreateAppForm organizationId={organization.id} />
      </header>

      {apps.length === 0 ? (
        <EmptyState
          title="Create your first app"
          message="Add the mobile app you want to measure. You will then connect Meta Ads and choose AppsFlyer or Tenjin as its attribution provider."
        />
      ) : (
        <Card>
          <ul className="list-reset stack">
            {apps.map((app) => (
              <li key={app.id} className="row-between" style={{ padding: '8px 0' }}>
                <div>
                  <Link href={`/apps/${app.id}`} style={{ fontWeight: 600 }}>
                    {app.name}
                  </Link>
                  <div className="inline-meta">
                    <span className="mono">{app.bundle_id}</span>
                    <span>{app.platform}</span>
                    <span>{app.timezone}</span>
                    <span>{app.default_currency}</span>
                  </div>
                </div>
                <div className="button-row">
                  {app.primary_attribution_provider ? (
                    <StatusChip
                      status="connected"
                      label={`MMP: ${app.primary_attribution_provider}`}
                    />
                  ) : (
                    <StatusChip status="pending" label="No attribution provider" />
                  )}
                  <Link className="nav-item" href={`/apps/${app.id}/integrations`}>
                    Integrations
                  </Link>
                  <Link className="nav-item" href={`/apps/${app.id}`}>
                    Command Center
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
