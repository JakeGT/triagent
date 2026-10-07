import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { announce } from "@/components/announcer";
import { Button } from "@/components/ui/button";

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 2000);
        return () => clearTimeout(t);
    }, [copied]);
    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            className={className}
            onClick={async () => {
                try {
                    await navigator.clipboard.writeText(value);
                    setCopied(true);
                    announce("Copied to the clipboard.");
                } catch {
                    announce("Couldn't copy. Select the text and copy it yourself.");
                }
            }}
        >
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : label}
        </Button>
    );
}
