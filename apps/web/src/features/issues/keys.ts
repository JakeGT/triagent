/** True when a keystroke belongs to a field or an open menu or dialog, not to the page's shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
    return Boolean(target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'));
}
