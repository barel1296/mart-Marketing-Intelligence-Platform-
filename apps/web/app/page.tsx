import { redirect } from 'next/navigation';
import { isAuthenticated } from '../lib/api';

export default async function Home() {
  redirect((await isAuthenticated()) ? '/apps' : '/login');
}
