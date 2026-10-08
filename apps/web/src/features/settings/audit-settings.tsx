import { useQuery } from "@tanstack/react-query";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { auditQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import { ReadOnlyNote, SettingsPage } from "./settings-page";

/** `{role: {from: "editor", to: "admin"}}` as "role: editor → admin". Secrets are only ever "set" or "cleared" here. */
export function describeChanges(changes: Record<string, unknown>): string {
    const text = (v: unknown): string => {
        if (v === null || v === undefined) return "none";
        if (typeof v !== "object") return String(v);
        const o = v as Record<string, unknown>;
        if ("from" in o && "to" in o) return `${text(o.from)} → ${text(o.to)}`;
        return Object.entries(o)
            .map(([k, x]) => `${k} ${text(x)}`)
            .join(", ");
    };
    return Object.entries(changes)
        .map(([k, v]) => `${k}: ${text(v)}`)
        .join("; ");
}

export function AuditSettings() {
    const { ws, workspace, can } = useWorkspace();
    const allowed = can("members");
    const query = useQuery({ ...auditQuery(ws), enabled: allowed });
    return (
        <SettingsPage
            title="Audit log"
            description={`Administrative changes in ${workspace.name}: members, tokens, settings and secrets (names only, never values). Newest first.`}
        >
            {!allowed ? (
                <ReadOnlyNote>Only admins of this workspace can see the audit log.</ReadOnlyNote>
            ) : query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : query.isPending ? (
                <LoadingRows rows={5} />
            ) : query.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing yet.</p>
            ) : (
                <TableFrame>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>When</TableHead>
                                <TableHead>Who</TableHead>
                                <TableHead>What</TableHead>
                                <TableHead>Changes</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {query.data.map((row) => (
                                <TableRow key={row.id} className="align-top">
                                    <TableCell className="text-xs whitespace-nowrap">
                                        <time dateTime={row.at}>{formatDateTime(row.at)}</time>
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        {row.actor}
                                        <div className="text-muted-foreground">
                                            via {row.via}
                                            {row.ip ? ` from ${row.ip}` : ""}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        {row.kind}
                                        <div className="max-w-48 truncate font-mono text-muted-foreground">{row.target}</div>
                                    </TableCell>
                                    <TableCell className="max-w-md text-xs break-words whitespace-normal">
                                        {describeChanges(row.changes)}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableFrame>
            )}
        </SettingsPage>
    );
}
