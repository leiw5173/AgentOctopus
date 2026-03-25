/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@octopus/core', '@octopus/registry'],
  serverExternalPackages: ['@octopus/adapters', '@modelcontextprotocol/sdk'],
};

export default nextConfig;
