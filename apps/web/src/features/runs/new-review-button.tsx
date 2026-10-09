// The way to the Start a review page, for people who can start reviews.

import { Link } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCan, useProject } from "@/lib/session";

export function NewReviewButton() {
    const { ws, slug } = useProject();
    const can = useCan();
    if (!can("operate")) return null;
    return (
        <Button asChild>
            <Link to="/w/$ws/p/$project/start-review" params={{ ws, project: slug }}>
                <Play /> Start review
            </Link>
        </Button>
    );
}
