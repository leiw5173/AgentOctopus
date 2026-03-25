/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@agentoctopus/core', '@agentoctopus/registry'],
  serverExternalPackages: ['@agentoctopus/adapters', '@modelcontextprotocol/sdk'],
};

export default nextConfig;
