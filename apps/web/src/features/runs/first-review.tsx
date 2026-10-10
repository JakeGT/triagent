// The first actions of a project with no report yet, for the empty states of its pages: start a review,
// or upload a report Open Code Review already wrote. Each is offered only to people who may do it.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { overviewQuery } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import { NewReviewButton } from "./new-review-button";

/** Whether the branch has no report at all (as opposed to a report with nothing of this kind in it). */
export function useNoReportYet(): boolean {
    const { ws, slug, branch } = useProject();
    // The rail asks for the same overview, so this is already in the cache.
    const overview = useQuery(overviewQuery(ws, slug, branch));
    return overview.data?.meta.loaded === false;
}

export function FirstReviewActions({
    quiet,
    upload = true,
}: {
    /** The page's header already has the filled Start review button: this one is outlined. */
    quiet?: boolean;
    /** Offer "Upload a report" (not on Branches & reports, where the upload form is on the page). */
    upload?: boolean;
}) {
    const { ws, slug } = useProject();
    const can = useCan();
    const canUpload = upload && can("upload");
    if (!can("operate") && !canUpload)
        // On a page that already says who can, nothing more to add.
        return quiet ? null : (
            <p className="text-sm text-muted-foreground">Ask an admin of this workspace to start a review or upload a report.</p>
        );
    return (
        <div className="flex flex-wrap items-center gap-2 pt-1">
            <NewReviewButton variant={quiet ? "outline" : "default"} />
            {canUpload && (
                <Button asChild variant="outline">
                    <Link to="/w/$ws/p/$project/branches" params={{ ws, project: slug }}>
                        <Upload /> Upload a report
                    </Link>
                </Button>
            )}
        </div>
    );
}
