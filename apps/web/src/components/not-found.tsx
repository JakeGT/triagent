import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
    return (
        <main id="content" className="mx-auto flex min-h-[60svh] max-w-lg flex-col justify-center gap-3 p-6">
            <h1 className="text-2xl font-semibold">Nothing here</h1>
            <p className="text-muted-foreground">
                This page doesn't exist, or it's in a workspace you're not a member of. Check the address, or go back to your workspace.
            </p>
            <div>
                <Button asChild>
                    <Link to="/dashboard">Go to my workspace</Link>
                </Button>
            </div>
        </main>
    );
}
