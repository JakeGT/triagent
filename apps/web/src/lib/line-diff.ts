export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** A line-by-line diff (longest common subsequence). Snippets in findings are short, so O(n·m) is fine. */
export function lineDiff(before: string, after: string): DiffLine[] {
    const a = before.replace(/\r\n/g, "\n").split("\n");
    const b = after.replace(/\r\n/g, "\n").split("\n");
    if (a.length * b.length > 4_000_000) {
        return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
    }
    const n = a.length;
    const m = b.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        const row = lcs[i] as number[];
        const next = lcs[i + 1] as number[];
        for (let j = m - 1; j >= 0; j--)
            row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({ kind: "same", text: a[i] as string });
            i++;
            j++;
        } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) out.push({ kind: "del", text: a[i++] as string });
        else out.push({ kind: "add", text: b[j++] as string });
    }
    while (i < n) out.push({ kind: "del", text: a[i++] as string });
    while (j < m) out.push({ kind: "add", text: b[j++] as string });
    return out;
}
