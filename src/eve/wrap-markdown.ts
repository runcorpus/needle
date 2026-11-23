import { fromMarkdown } from "mdast-util-from-markdown";

export function wrapMarkdown(source: string): string {
  const cuts: number[] = [];
  for (const paragraph of fromMarkdown(source).children) {
    if (paragraph.type !== "paragraph") continue;
    const start = paragraph.position!.start.offset!;
    const end = paragraph.position!.end.offset!;
    const raw = source.slice(start, end);
    if (raw.includes("|")) continue;
    const spaces = new Set<number>();
    const children = paragraph.children;
    function collect(node: (typeof children)[number]) {
      if (node.type === "text") {
        const offset = node.position!.start.offset!;
        const text = source.slice(offset, node.position!.end.offset!);
        for (const match of text.matchAll(/(?<=\S) (?=\S)/g)) {
          const at = offset + match.index;
          if (
            source[at - 1] === "\\" ||
            /^(?:[#>*+\-`~<=\[]|\d+[.)]\s)/.test(source.slice(at + 1, at + 24))
          ) {
            continue;
          }
          spaces.add(at);
        }
      } else if (node.type === "emphasis" || node.type === "strong") {
        for (const child of node.children) collect(child);
      }
    }
    for (const child of children) collect(child);
    let offset = start;
    for (const line of raw.split("\n")) {
      const candidates = [...line.matchAll(/ /g)]
        .map((match) => match.index)
        .filter((index) => spaces.has(offset + index));
      let begin = 0;
      let next = 0;
      while (line.length - begin > 160 && next < candidates.length) {
        let word: number | undefined;
        let sentence: number | undefined;
        for (let i = next; i < candidates.length && candidates[i]! - begin <= 160; i++) {
          const at = candidates[i]!;
          const width = at - begin;
          if (width <= 140) word = at;
          if (
            width >= 120 &&
            /[.!?]["'’”)]?$/.test(line.slice(Math.max(begin, at - 3), at)) &&
            (sentence === undefined || Math.abs(width - 140) < Math.abs(sentence - begin - 140))
          ) {
            sentence = at;
          }
        }
        const cut = sentence ?? word ?? candidates[next]!;
        cuts.push(offset + cut);
        begin = cut + 1;
        while (next < candidates.length && candidates[next]! < begin) next++;
      }
      offset += line.length + 1;
    }
  }
  const result: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    result.push(source.slice(start, cut), "\n");
    start = cut + 1;
  }
  result.push(source.slice(start));
  return result.join("");
}
