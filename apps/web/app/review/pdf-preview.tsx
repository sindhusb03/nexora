"use client";

import type { Bbox } from "./source-types";
import { useEffect, useRef, useState } from "react";

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface PdfViewport {
  width: number;
  height: number;
  convertToViewportRectangle: (rect: readonly number[]) => number[];
}

interface PdfPageProxy {
  getViewport: (params: { scale: number }) => PdfViewport;
  getTextContent: () => Promise<{ items: readonly { str?: string }[] }>;
  render: (params: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => {
    promise: Promise<void>;
  };
}

interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (src: { data: Uint8Array }) => {
    promise: Promise<{ getPage: (page: number) => Promise<PdfPageProxy> }>;
  };
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const SCALE = 1.25;

function isPdfjs(value: unknown): value is PdfjsModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { getDocument?: unknown; GlobalWorkerOptions?: unknown };
  return typeof candidate.getDocument === "function" && candidate.GlobalWorkerOptions !== undefined;
}

export function PdfPreview({
  pdfBase64,
  bbox,
  rawText,
  page = 1,
}: {
  readonly pdfBase64: string;
  readonly bbox: Bbox | null;
  readonly rawText: string;
  readonly page?: number;
}) {
  const pageNumber = page > 0 ? page : 1;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: PAGE_WIDTH * SCALE, height: PAGE_HEIGHT * SCALE });
  const [box, setBox] = useState<Box | null>(null);
  const [pageText, setPageText] = useState("");
  const [mode, setMode] = useState<"rendering" | "pdf" | "fallback">("rendering");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded: unknown = await import("pdfjs-dist");
        if (cancelled) return;
        if (!isPdfjs(loaded)) {
          setMode("fallback");
          return;
        }
        loaded.GlobalWorkerOptions.workerSrc = "/pdf-worker";
        const binary = Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0));
        const document = await loaded.getDocument({ data: binary }).promise;
        const pdfPage = await document.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale: SCALE });
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context || cancelled) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await pdfPage.render({ canvasContext: context, viewport }).promise;
        const text = await pdfPage.getTextContent();
        if (cancelled) return;
        setPageText(
          text.items
            .map((item) => item.str ?? "")
            .join(" ")
            .trim(),
        );
        setSize({ width: viewport.width, height: viewport.height });
        if (bbox) {
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
            bbox.x,
            bbox.y,
            bbox.x + bbox.width,
            bbox.y + bbox.height,
          ]);
          setBox({
            left: Math.min(x1 ?? 0, x2 ?? 0),
            top: Math.min(y1 ?? 0, y2 ?? 0),
            width: Math.abs((x2 ?? 0) - (x1 ?? 0)),
            height: Math.abs((y2 ?? 0) - (y1 ?? 0)),
          });
        }
        setMode("pdf");
      } catch {
        if (!cancelled) setMode("fallback");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bbox, pageNumber, pdfBase64]);

  return (
    <div
      className="review-source"
      data-testid="source-pdf"
      data-render={mode}
      data-page={pageNumber}
    >
      <div className="review-page" style={{ width: size.width, height: size.height }}>
        <canvas ref={canvasRef} aria-label="Source PDF page" />
        <p className="sr-only" data-testid="pdf-text">
          {pageText}
        </p>
        {mode === "fallback" ? (
          <p className="pad small" data-testid="pdf-raw">
            {rawText}
          </p>
        ) : null}
        {mode === "pdf" && box ? (
          <span
            className="review-highlight"
            data-testid="bbox-highlight"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            aria-label="Highlighted source region"
          />
        ) : null}
      </div>
    </div>
  );
}
