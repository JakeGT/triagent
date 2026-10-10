import { Eye, EyeOff } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type PasswordInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
    ref?: React.Ref<HTMLInputElement>;
};

export function PasswordInput({ className, disabled, ref, ...props }: PasswordInputProps) {
    const [showPassword, setShowPassword] = React.useState(false);

    return (
        <div className={cn("relative rounded-md", className)}>
            {/* The shared input's look (focus ring, invalid state), with room on the end for the toggle. */}
            <Input ref={ref} disabled={disabled} {...props} type={showPassword ? "text" : "password"} className="pe-9" />
            <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={disabled}
                className="absolute inset-e-1 top-1/2 h-6 w-6 -translate-y-1/2 rounded-md text-muted-foreground"
                title={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((prev) => !prev)}
            >
                {showPassword ? <Eye size={18} /> : <EyeOff size={18} />}
                <span className="sr-only">{showPassword ? "Hide password" : "Show password"}</span>
            </Button>
        </div>
    );
}
