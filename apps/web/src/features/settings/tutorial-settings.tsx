// Settings → Account → Tutorial: take the tour again (making a new example project if it was removed),
// or remove the example project.

import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { FormActions } from "@/components/form";
import { Button } from "@/components/ui/button";
import { keys } from "@/lib/queries";
import { useMe } from "@/lib/session";
import { requestTour, tutorialApi } from "@/lib/tutorial";
import type { TutorialStatus } from "@/lib/types";
import { SettingsPage, SettingsSection } from "./settings-page";

const STATUS: Record<TutorialStatus, string> = {
    pending: "You haven't taken the tour yet.",
    in_progress: "You're part-way through the tour.",
    completed: "You finished the tour.",
    dismissed: "You skipped the tour.",
};

export function TutorialSettings() {
    const me = useMe();
    const queryClient = useQueryClient();
    const example = me.tutorial.example;
    return (
        <SettingsPage title="Tutorial" description="A short tour of Triagent, using an example project in your personal workspace.">
            <SettingsSection title="The tour" description={STATUS[me.tutorial.status]}>
                <FormActions>
                    <Button type="button" onClick={() => requestTour()}>
                        Show the tutorial again
                    </Button>
                </FormActions>
            </SettingsSection>
            <SettingsSection
                title="Example project"
                description="Made-up findings for a small web shop, so every page has something to show. Nothing in it reaches GitHub or a model."
            >
                {example ? (
                    <>
                        <p className="text-sm">
                            It's{" "}
                            <Link
                                to="/w/$ws/p/$project/overview"
                                params={{ ws: example.workspace, project: example.project }}
                                className="link"
                            >
                                Example: Acme Shop
                            </Link>{" "}
                            in your personal workspace.
                        </p>
                        <FormActions>
                            <ConfirmAction
                                trigger={
                                    <Button variant="danger">
                                        <Trash2 /> Remove the example project
                                    </Button>
                                }
                                title="Remove the example project?"
                                description="Its reports, triage, runs and notes are deleted. Showing the tutorial again makes a new one."
                                confirmLabel="Remove the example"
                                onConfirm={async () => {
                                    await tutorialApi.removeExample();
                                    queryClient.removeQueries({ queryKey: keys.project(example.workspace, example.project) });
                                    await Promise.all([
                                        queryClient.invalidateQueries({ queryKey: keys.me }),
                                        queryClient.invalidateQueries({ queryKey: keys.projects(example.workspace) }),
                                    ]);
                                    toast.success("The example project is removed.");
                                }}
                            />
                        </FormActions>
                    </>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        You have no example project. Showing the tutorial again makes a new one.
                    </p>
                )}
            </SettingsSection>
        </SettingsPage>
    );
}
