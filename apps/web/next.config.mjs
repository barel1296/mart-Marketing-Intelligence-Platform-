/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The browser never talks to a provider, and never talks to the API
  // cross-origin: /api is proxied so the session cookie is first-party.
  //
  // MART_API_INTERNAL_URL is read at BUILD time: Next writes the destination
  // into .next/routes-manifest.json and `next start` never re-evaluates this
  // function. Setting it only in the runtime environment has no effect.
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.MART_API_INTERNAL_URL ?? 'http://localhost:4000'}/api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'x-content-type-options', value: 'nosniff' },
          { key: 'x-frame-options', value: 'DENY' },
          { key: 'referrer-policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
