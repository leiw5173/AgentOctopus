/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@agentoctopus/core', '@agentoctopus/registry', '@agentoctopus/adapters', '@modelcontextprotocol/sdk'],
};

export default nextConfig;
