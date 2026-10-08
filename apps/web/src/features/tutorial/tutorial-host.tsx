// Runs the first-run tutorial: starts it on the first sign-in (status "pending"), picks it up where it was
// left (status "in_progress": closing the browser mid-tour), or starts it again when Settings → Tutorial
// asks. Each step goes to its page in the example project and saves where the person is, so the server
// always knows; skipping marks the tour dismissed, and it doesn't come back by itself.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { announce } from "@/components/announcer";
import { TourCard } from "@/components/tour";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { issueQuery, keys, meQuery } from "@/lib/queries";
import { tutorialApi, useTourRequests } from "@/lib/tutorial";
import type { TutorialStatus } from "@/lib/types";
import { type Example, STEPS } from "./steps";

interface Running {
    step: number;
    example: Example;
}

export function TutorialHost() {
    const me = useQuery(meQuery).data;
    const queryClient = useQueryClient();
    const router = useRouter();
    const requests = useTourRequests();
    const [run, setRun] = useState<Running | null>(null);
    const begun = useRef<number | null>(null);

    const refreshMe = useCallback(() => queryClient.invalidateQueries({ queryKey: keys.me }), [queryClient]);

    const begin = useCallback(
        async (step: number) => {
            try {
                const made = await tutorialApi.createExample();
                if (!made.example) return;
                await tutorialApi.update({ status: "in_progress", step });
                await Promise.all([refreshMe(), queryClient.invalidateQueries({ queryKey: keys.projects(made.example.workspace) })]);
                setRun({ step: Math.min(step, STEPS.length - 1), example: made.example });
            } catch (err) {
                toast.error(`The tutorial couldn't start: ${errorMessage(err)}`);
            }
        },
        [queryClient, refreshMe],
    );

    // The first sign-in, or a tour left part-way: once per page load.
    const status = me?.tutorial.status;
    useEffect(() => {
        if (begun.current !== null || !me || me.mustChangePassword) return;
        if (status === "pending" || status === "in_progress") {
            begun.current = requests;
            void begin(status === "in_progress" ? me.tutorial.step : 0);
        }
    }, [status, me, begin, requests]);

    // Settings → Tutorial: start again from the beginning.
    useEffect(() => {
        if (requests === 0 || begun.current === requests) return;
        begun.current = requests;
        void begin(0);
    }, [requests, begin]);

    const step = run ? STEPS[run.step] : undefined;
    // Go to the step's page.
    useEffect(() => {
        if (!run || !step?.path) return;
        const href = step.path(run.example);
        const here = `${router.state.location.pathname}${router.state.location.searchStr}`;
        if (here !== href) void router.navigate({ href });
    }, [run, step, router]);

    // A "try it" step watches the issue it asked about.
    const tryIssue = useQuery({
        ...issueQuery(run?.example.workspace ?? "", run?.example.project ?? "", "main", run?.example.issue ?? ""),
        enabled: Boolean(run && step?.tryIt && run.example.issue),
    });
    const done = step?.tryIt === "resolve-issue" ? tryIssue.data?.status === "resolved" : true;
    useEffect(() => {
        if (step?.tryIt && done) announce("Resolved. Nicely done: carry on when you're ready.");
    }, [step, done]);

    if (!run || !step || !me) return null;

    const go = (to: number) => {
        setRun({ ...run, step: to });
        void tutorialApi.update({ step: to }).catch(() => {});
    };
    const end = async (next: TutorialStatus, message: string) => {
        setRun(null);
        try {
            await tutorialApi.update({ status: next });
            await refreshMe();
        } catch (err) {
            toast.error(errorMessage(err));
        }
        announce(message);
    };
    const skip = () => void end("dismissed", "Tour closed. You can take it again from Settings, under Tutorial.");
    const last = run.step === STEPS.length - 1;
    const removeExample = async () => {
        const example = run.example;
        try {
            await tutorialApi.removeExample();
            queryClient.removeQueries({ queryKey: keys.project(example.workspace, example.project) });
            await queryClient.invalidateQueries({ queryKey: keys.projects(example.workspace) });
            await router.navigate({ href: `/w/${encodeURIComponent(example.workspace)}` });
            toast.success("The example project is removed.");
        } catch (err) {
            toast.error(errorMessage(err));
            return;
        }
        await end("completed", "Tour finished.");
    };

    return (
        <TourCard
            key={step.id}
            id={step.id}
            anchor={step.anchor}
            title={step.title}
            index={run.step}
            total={STEPS.length}
            onBack={run.step > 0 ? () => go(run.step - 1) : undefined}
            onSkip={skip}
            onNext={() => (last ? void end("completed", "Tour finished. The example project is kept.") : go(run.step + 1))}
            nextLabel={last ? "Keep the example" : step.tryIt && !done ? "Waiting…" : run.step === 0 ? "Start the tour" : "Next"}
            nextDisabled={!done}
            actions={
                last ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => void removeExample()}>
                        Remove the example
                    </Button>
                ) : step.tryIt && !done ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => go(run.step + 1)}>
                        Skip this step
                    </Button>
                ) : undefined
            }
        >
            {step.body({ example: run.example, isInstanceAdmin: me.user.isInstanceAdmin })}
        </TourCard>
    );
}
