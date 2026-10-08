import type { NextConfig } from "next";

const production = process.env.NODE_ENV === "production";

/**
 * Framing, sniffing, and referrer protections for every page. Script sources stay unrestricted here because the
 * Next.js runtime injects inline bootstrap scripts; a nonce-based script-src belongs with middleware.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  ...(production
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

/**
 * Same-origin API proxy for the Render container. Unset locally, so dev and the
 * existing web image keep calling NEXT_PUBLIC_API_URL directly.
 * `fallback` runs after App Router handlers, so `app/api/kernel-health` still wins.
 */
function apiProxyTarget(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (value.length === 0) return null;
  if (!/^https?:\/\/[^/\s]+$/.test(value)) {
    throw new Error("API_PROXY_TARGET must be a scheme and host with no path");
  }
  return value;
}

const proxyTarget = apiProxyTarget(process.env.API_PROXY_TARGET);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@nexora/contracts", "@nexora/kernel"],
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  ...(proxyTarget
    ? {
        async rewrites() {
          return {
            fallback: [{ source: "/api/:path*", destination: `${proxyTarget}/:path*` }],
          };
        },
      }
    : {}),
};

export default nextConfig;
