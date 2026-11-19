import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@auction/shared'],
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
};
export default createNextIntlPlugin('./src/shared/lib/i18n-request.ts')(config);
