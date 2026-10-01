import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * pdf.js loads this URL as its worker. A bundled `require.resolve` of a variable
 * path returns 404 after Next compiles the route, so the file is read from the
 * installed package on disk. `pnpm --filter @nexora/web` runs with this app as cwd.
 */
const workerPaths = [
  path.join(process.cwd(), "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
  path.join(process.cwd(), "apps/web/node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
];

export async function GET(): Promise<NextResponse> {
  for (const workerPath of workerPaths) {
    try {
      const body = await readFile(workerPath);
      return new NextResponse(new Uint8Array(body), {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=86400",
        },
      });
    } catch {
      // The other cwd is used when the dev server is started from the repo root.
    }
  }
  return new NextResponse("pdf.js worker is not installed", { status: 404 });
}
