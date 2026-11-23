"use client";

import { useEffect, useState } from "react";

export function ReportCardActions({ cardId, anchor = cardId, label }: {
  cardId: string;
  anchor?: string;
  label: string;
}) {
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 2400);
    return () => window.clearTimeout(timer);
  }, [message]);

  async function copyLink() {
    try {
      const url = new URL(window.location.href);
      url.hash = anchor;
      await navigator.clipboard.writeText(url.href);
      setMessage("Link copied");
    } catch {
      setMessage("Couldn’t copy link");
    }
  }

  async function download() {
    const card = document.getElementById(cardId);
    if (!card) return;
    setExporting(true);
    try {
      await document.fonts.ready;
      const { toBlob } = await import("html-to-image");
      const png = await toBlob(card, {
        pixelRatio: 2,
        filter: (node) => !(node instanceof Element && node.matches(".report-card-actions, .report-latency-tooltip")),
      });
      if (!png) throw new Error("PNG export produced no image.");
      const url = URL.createObjectURL(png);
      const link = document.createElement("a");
      link.href = url;
      link.download = `corpus-needle-${anchor}.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setMessage("Download started");
    } catch {
      setMessage("Couldn’t export chart");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="report-card-actions">
      <button type="button" onClick={copyLink} aria-label={`Copy link to ${label}`} title="Copy link">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {message === "Link copied" ? (
            <path d="m5 12 4 4L19 6" />
          ) : (
            <>
              <path d="M10 13a4 4 0 0 0 6 .4l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
              <path d="M14 11a4 4 0 0 0-6-.4l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
            </>
          )}
        </svg>
      </button>
      <button type="button" onClick={download} disabled={exporting} aria-label={`Download ${label} as PNG`} title="Download PNG">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" />
        </svg>
      </button>
      <span className="report-card-feedback" role="status">{message}</span>
    </div>
  );
}
