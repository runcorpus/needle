"use client";

import { useEffect, useState } from "react";

export function LocalTime({ iso, compact = false }: { iso: string; compact?: boolean }) {
  const [local, setLocal] = useState(false);
  useEffect(() => setLocal(true), []);

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <>{iso}</>;
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: local ? undefined : "UTC",
    month: "short",
    day: "numeric",
    ...(compact ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);

  return <time dateTime={iso} title={date.toUTCString()}>{label}</time>;
}

export function ReportCaption({ caption, latestRunAt }: { caption: string; latestRunAt?: string | null }) {
  const match = /^(.*\blatest )[^—]+ UTC$/.exec(caption);
  if (!match || !latestRunAt) return <>{caption}</>;
  return <>{match[1]}<LocalTime iso={latestRunAt} compact /></>;
}
