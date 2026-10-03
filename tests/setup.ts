import { afterAll, afterEach, beforeAll } from "vitest";
import { mockServer } from "./helpers.js";

beforeAll(() => mockServer.listen({ onUnhandledFrame: "error" }));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());
