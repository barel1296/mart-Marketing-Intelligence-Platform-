import { redirect } from 'next/navigation';
import { isAuthenticated } from '../../lib/api';
import { AuthForm } from './AuthForm';

export default async function LoginPage() {
  if (await isAuthenticated()) redirect('/apps');
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="brand" style={{ marginBottom: 16 }}>
          <strong>MART</strong>
          <span>Marketing Autonomous Response &amp; Telemetry</span>
        </div>
        <AuthForm />
      </div>
    </main>
  );
}
