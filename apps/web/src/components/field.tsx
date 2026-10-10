// Form fields, laid out by one rule: the label above the control, then the description, then the error,
// all wired together with unique ids so assistive technology reads the label, description and error with
// the control. Fields side by side go in a FieldRow, which lines their controls up on one row (CSS
// subgrid) however long each label or description is.

import { createContext, type ReactNode, use, useId } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface FieldControlProps {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: true;
}

/** How wide a control is (it never grows past its container). Without one, it fills the field. */
export type ControlWidth = "xs" | "sm" | "md" | "lg";

const WIDTH: Record<ControlWidth, string> = {
    xs: "w-control-xs max-w-full",
    sm: "w-control-sm max-w-full",
    md: "w-control-md max-w-full",
    lg: "w-control-lg max-w-full",
};

/** Inside a FieldRow: each field spans the row's three lines (label, control, then description and error). */
const InRow = createContext(false);
const ROW_ITEM = "sm:row-span-3 sm:grid-rows-subgrid";

/**
 * For fields built by hand (SecretField): the classes that put one in its FieldRow's lines, and its
 * label's, or none outside a row.
 */
export function useFieldRowItem(): { item: string; label: string } {
    return use(InRow) ? { item: ROW_ITEM, label: "sm:self-end" } : { item: "", label: "" };
}

function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
    return ids.filter(Boolean).join(" ") || undefined;
}

export function Field({
    label,
    hint,
    error,
    width,
    className,
    children,
}: {
    label: ReactNode;
    /** What the field is for: always shown below the control. */
    hint?: ReactNode;
    error?: string | null;
    width?: ControlWidth;
    className?: string;
    children: (props: FieldControlProps) => ReactNode;
}) {
    const inRow = use(InRow);
    const id = useId();
    const hintId = `${id}-hint`;
    const errorId = `${id}-error`;
    return (
        <div data-field="" className={cn("grid grid-cols-[minmax(0,1fr)] content-start gap-field", inRow && ROW_ITEM, className)}>
            <Label htmlFor={id} className={cn("leading-snug", inRow && "sm:self-end")}>
                {label}
            </Label>
            <div data-field-control="" className={cn("min-w-0", width && WIDTH[width])}>
                {children({
                    id,
                    "aria-describedby": describedBy(hint ? hintId : null, error ? errorId : null),
                    ...(error ? { "aria-invalid": true as const } : {}),
                })}
            </div>
            {(hint || error) && (
                <div className="grid content-start gap-field">
                    {hint && <FieldHint id={hintId}>{hint}</FieldHint>}
                    <FieldError id={errorId} message={error} />
                </div>
            )}
        </div>
    );
}

/** The description under a control. */
export function FieldHint({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
    return (
        <p id={id} className={cn("max-w-measure text-xs leading-normal text-muted-foreground", className)}>
            {children}
        </p>
    );
}

const COLUMNS = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    /** As wide as each control: filter bars. */
    auto: "sm:grid-flow-col sm:grid-rows-[repeat(3,auto)] sm:auto-cols-max sm:justify-start",
} as const;

/**
 * Fields side by side. Their labels share a line, and so do their controls, so the inputs line up even
 * when one label wraps or only one field has a description. On phones they stack.
 */
export function FieldRow({
    columns = 2,
    className,
    children,
}: {
    columns?: keyof typeof COLUMNS;
    /** Extra classes, e.g. custom column widths (sm:grid-cols-[2fr_1fr]). */
    className?: string;
    children: ReactNode;
}) {
    return (
        <InRow value={true}>
            <div data-field-row="" className={cn("grid gap-x-form gap-y-form", COLUMNS[columns], className)}>
                {children}
            </div>
        </InRow>
    );
}

/** A control with buttons beside it (Copy, Save): the control takes the room left. */
export function ControlGroup({ children, className }: { children: ReactNode; className?: string }) {
    return <div className={cn("flex flex-wrap items-center gap-2 *:first:min-w-0 *:first:flex-1", className)}>{children}</div>;
}

/** Buttons that belong on a FieldRow's line of controls (Compare, Show, Add). */
export function FieldRowActions({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div className={cn("grid gap-field", ROW_ITEM)}>
            <div data-field-actions="" className={cn("flex flex-wrap items-center gap-2 sm:row-start-2", className)}>
                {children}
            </div>
        </div>
    );
}

/**
 * A switch or checkbox with its label beside it and the description underneath the label. The control
 * sits on the label's first line.
 */
export function CheckField({
    label,
    hint,
    className,
    children,
}: {
    label: ReactNode;
    hint?: ReactNode;
    className?: string;
    children: (props: FieldControlProps) => ReactNode;
}) {
    const id = useId();
    const hintId = `${id}-hint`;
    return (
        <div data-check-field="" className={cn("grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5", className)}>
            <span className="flex h-5 items-center">{children({ id, "aria-describedby": hint ? hintId : undefined })}</span>
            <Label htmlFor={id} className="min-h-5 leading-5 font-medium">
                {label}
            </Label>
            {hint && (
                <FieldHint id={hintId} className="col-start-2">
                    {hint}
                </FieldHint>
            )}
        </div>
    );
}

export interface Choice<T extends string> {
    value: T;
    label: ReactNode;
    hint?: ReactNode;
    /** This one can't be chosen (its hint says why). */
    disabled?: boolean;
}

/** One choice from a few, as radio buttons, each with an optional description. */
export function ChoiceField<T extends string>({
    legend,
    hideLegend,
    hint,
    name,
    value,
    choices,
    onChange,
    disabled,
}: {
    legend: ReactNode;
    /** For a choice whose section title already says what it is. */
    hideLegend?: boolean;
    hint?: ReactNode;
    name: string;
    value: T;
    choices: readonly Choice<NoInfer<T>>[];
    onChange(value: NoInfer<T>): void;
    disabled?: boolean;
}) {
    const id = useId();
    return (
        <fieldset className="grid gap-field" aria-describedby={hint ? `${id}-hint` : undefined}>
            <legend className={cn("mb-field text-sm leading-snug font-medium", hideLegend && "sr-only")}>{legend}</legend>
            <div className="grid gap-2">
                {choices.map((c) => (
                    <div key={c.value} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5">
                        <span className="flex h-5 items-center">
                            <input
                                type="radio"
                                id={`${id}-${c.value}`}
                                name={name}
                                value={c.value}
                                checked={value === c.value}
                                onChange={() => onChange(c.value)}
                                disabled={disabled || c.disabled}
                                aria-describedby={c.hint ? `${id}-${c.value}-hint` : undefined}
                                className="size-4 accent-primary"
                            />
                        </span>
                        <label htmlFor={`${id}-${c.value}`} className="min-h-5 text-sm leading-5">
                            {c.label}
                        </label>
                        {c.hint && (
                            <FieldHint id={`${id}-${c.value}-hint`} className="col-start-2">
                                {c.hint}
                            </FieldHint>
                        )}
                    </div>
                ))}
            </div>
            {hint && <FieldHint id={`${id}-hint`}>{hint}</FieldHint>}
        </fieldset>
    );
}

/** An inline error. Rendered as an alert so it's read out when it appears. */
export function FieldError({ id, message, className }: { id?: string; message?: string | null; className?: string }) {
    if (!message) return null;
    return (
        <p id={id} role="alert" className={cn("text-sm text-destructive", className)}>
            {message}
        </p>
    );
}

/** A native select, styled like the inputs. Changing it never navigates. */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
    return (
        <select
            className={cn(
                "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none",
                "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
                "aria-invalid:border-destructive dark:bg-input/30",
                className,
            )}
            {...props}
        />
    );
}
