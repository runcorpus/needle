import type { VerticalId } from "./types";

export const benchmarkSuites = ["scholar", "news", "finance", "agentic_rare", "legal"] as const;
type Interval = [number, number];

export interface MeasuredQuestion {
  queryId: string;
  bucket: string;
  score: number;
  ultimate: number;
}

export interface MeasuredBatch {
  id: string;
  suite: VerticalId;
  questions: MeasuredQuestion[];
}

interface ScoreGroup {
  count: number;
  score: number;
  ultimate: number;
}

export interface CorpusWeeklyScore {
  mean: number;
  interval: Interval | null;
}

export interface CorpusWeeklySuite {
  runs: number;
  questions: number;
  latestRunId: string;
  ultimate: number;
  score: CorpusWeeklyScore;
  byBucket: Record<string, number>;
}

export interface CorpusWeeklyStats {
  suites: Partial<Record<VerticalId, CorpusWeeklySuite>>;
  overall: CorpusWeeklyScore | null;
  latency: { search: Interval | null; agent: Interval | null };
}

export interface CorpusWeeklyReport extends CorpusWeeklyStats {
  windowEnd: string;
  agent?: CorpusWeeklyStats;
}

function scoreGroup(): ScoreGroup {
  return { count: 0, score: 0, ultimate: 0 };
}

function addQuestion(group: ScoreGroup, { score, ultimate }: MeasuredQuestion) {
  group.count++;
  group.score += score;
  group.ultimate += ultimate;
}

export function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = p * (sorted.length - 1);
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

function interval(values: number[]): Interval | null {
  return values.length ? [percentile(values, 0.025), percentile(values, 0.975)] : null;
}

function randomGenerator(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function draw(groups: ScoreGroup[], random: () => number): ScoreGroup {
  const result = scoreGroup();
  for (let index = 0; index < groups.length; index++) {
    const group = groups[Math.floor(random() * groups.length)];
    result.count += group.count;
    result.score += group.score;
    result.ultimate += group.ultimate;
  }
  return result;
}

function suiteInterval(queryGroups: ScoreGroup[], runGroups: ScoreGroup[]) {
  if (queryGroups.length < 2 || runGroups.length < 2) return null;
  const random = randomGenerator(1926);
  const byQuery: number[] = [];
  const byRun: number[] = [];
  for (let i = 0; i < 10_000; i++) {
    const query = draw(queryGroups, random);
    const run = draw(runGroups, random);
    byQuery.push(query.score / query.count);
    byRun.push(run.score / run.count);
  }
  const queries = interval(byQuery)!;
  const runs = interval(byRun)!;
  return queries[1] - queries[0] > runs[1] - runs[0] ? queries : runs;
}

export function aggregateCorpusWeek(batches: MeasuredBatch[]): Pick<CorpusWeeklyReport, "suites" | "overall"> {
  const suites: CorpusWeeklyReport["suites"] = {};
  const runsBySuite: ScoreGroup[][] = [];
  for (const suite of benchmarkSuites) {
    const selected = batches.filter((batch) => batch.suite === suite && batch.questions.length);
    if (!selected.length) continue;
    const total = scoreGroup();
    const byQuery = new Map<string, ScoreGroup>();
    const byBucket = new Map<string, ScoreGroup>();
    const byRun = selected.map((batch) => {
      const group = scoreGroup();
      for (const question of batch.questions) {
        const query = byQuery.get(question.queryId) ?? scoreGroup();
        addQuestion(query, question);
        byQuery.set(question.queryId, query);
        const bucket = byBucket.get(question.bucket) ?? scoreGroup();
        addQuestion(bucket, question);
        byBucket.set(question.bucket, bucket);
        addQuestion(group, question);
        addQuestion(total, question);
      }
      return group;
    });
    runsBySuite.push(byRun);
    suites[suite] = {
      runs: selected.length,
      questions: total.count,
      latestRunId: selected[0].id,
      ultimate: total.ultimate / total.count,
      score: { mean: total.score / total.count, interval: suiteInterval([...byQuery.values()], byRun) },
      byBucket: Object.fromEntries([...byBucket].map(([bucket, group]) => [bucket, group.score / group.count])),
    };
  }

  const measured = Object.values(suites);
  if (measured.length !== benchmarkSuites.length || measured.some(({ ultimate }) => ultimate <= 0)) return { suites, overall: null };
  const scores: number[] = [];
  if (runsBySuite.every((groups) => groups.length >= 2)) {
    const random = randomGenerator(1926);
    for (let i = 0; i < 2_000; i++) {
      const sample = runsBySuite.map((groups) => draw(groups, random));
      if (sample.some(({ ultimate }) => ultimate <= 0)) continue;
      scores.push(sample.reduce((sum, run) => sum + run.score / run.ultimate, 0) / sample.length);
    }
  }
  return {
    suites,
    overall: {
      mean: measured.reduce((sum, suite) => sum + suite.score.mean / suite.ultimate, 0) / measured.length,
      interval: interval(scores),
    },
  };
}
