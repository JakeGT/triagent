import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no layout: the router's scroll restoration calls these.
window.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};

afterEach(() => cleanup());
