// Settings → Workspace → Model prices: what each model costs here, so Analytics can show what reviews
// cost. A workspace's own price wins over the instance's, which wins over OpenRouter's listed price.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { LoadError, LoadingRows } from "@/components/load-state";
import { PriceEditor } from "@/components/price-editor";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, paths } from "@/lib/api";
import { compactCount, count, perMillion, SOURCE_LABEL } from "@/lib/insights-format";
import { catalogueQuery, insightKeys, pricesQuery } from "@/lib/insights-queries";
import { useWorkspace } from "@/lib/session";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

export function ModelPricesSettings() {
    const { ws, can } = useWorkspace();
    const editable = can("configure");
    const queryClient = useQueryClient();
    const query = useQuery(pricesQuery(ws));
    const catalogue = useQuery({ ...catalogueQuery(ws), enabled: editable });
    const refresh = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: insightKeys.prices(ws) }),
            queryClient.invalidateQueries({ queryKey: ["ws", ws, "analytics"] }),
        ]);
    const url = `${paths.workspace(ws)}/settings/model-prices`;

    return (
        <SettingsPage
            title="Model prices"
            description="What each model costs, in US dollars per million tokens, so Analytics can show what reviews cost. Prices apply to past reviews too."
        >
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : !query.data ? (
                <LoadingRows rows={4} />
            ) : (
                <>
                    <SettingsSection
                        title="Models your reviews used"
                        description="Each model's price comes from this workspace, else the instance, else OpenRouter's list. Models without a price are left out of costs."
                    >
                        {query.data.used.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No reviews have recorded a model yet.</p>
                        ) : (
                            <Table>
                                <caption className="sr-only">Models used by this workspace's reviews and their prices</caption>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead scope="col">Model</TableHead>
                                        <TableHead scope="col" className="text-end">
                                            Reviews
                                        </TableHead>
                                        <TableHead scope="col" className="text-end">
                                            Tokens
                                        </TableHead>
                                        <TableHead scope="col" className="text-end">
                                            Input
                                        </TableHead>
                                        <TableHead scope="col" className="text-end">
                                            Output
                                        </TableHead>
                                        <TableHead scope="col">Price from</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {query.data.used.map((u) => (
                                        <TableRow key={u.model}>
                                            <TableCell className="font-mono text-xs break-all whitespace-normal">{u.model}</TableCell>
                                            <TableCell className="text-end tabular-nums">{count(u.reviews)}</TableCell>
                                            <TableCell className="text-end tabular-nums">{compactCount(u.tokens)}</TableCell>
                                            <TableCell className="text-end tabular-nums">
                                                {u.price ? perMillion(u.price.input) : "—"}
                                            </TableCell>
                                            <TableCell className="text-end tabular-nums">
                                                {u.price ? perMillion(u.price.output) : "—"}
                                            </TableCell>
                                            <TableCell>
                                                {u.price ? (
                                                    SOURCE_LABEL[u.price.source]
                                                ) : (
                                                    <strong className="font-medium">No price: left out of costs</strong>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </SettingsSection>
                    <SettingsSection title="This workspace's prices" description="These override the instance's prices and OpenRouter's.">
                        {!editable && <ReadOnlyNote />}
                        <PriceEditor
                            title="prices for this workspace"
                            prices={query.data.prices}
                            canEdit={editable}
                            catalogue={catalogue.data?.models ?? []}
                            onSave={async (p) => {
                                await api.put(url, p);
                                await refresh();
                                toast.success(`Price for ${p.model} saved.`);
                            }}
                            onRemove={async (model) => {
                                await api.delete(url, { model });
                                await refresh();
                                toast.success(`Price for ${model} removed.`);
                            }}
                        />
                    </SettingsSection>
                    {query.data.instance.length > 0 && (
                        <SettingsSection title="Instance prices" description="Set by the instance administrator for every workspace.">
                            <PriceEditor
                                title="instance prices"
                                prices={query.data.instance}
                                canEdit={false}
                                onSave={async () => {}}
                                onRemove={async () => {}}
                            />
                        </SettingsSection>
                    )}
                </>
            )}
        </SettingsPage>
    );
}
