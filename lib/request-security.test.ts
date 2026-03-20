import { describe, expect, it } from "vitest";
import { validateSameOriginRequest } from "@/lib/request-security";

describe("validateSameOriginRequest", () => {
  it("accepts requests when the caller origin matches the request url", () => {
    const request = new Request("http://localhost:3000/api/session", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
      },
    });

    expect(validateSameOriginRequest(request)).toBeNull();
  });

  it("accepts requests when the caller origin matches the host header", () => {
    const request = new Request("http://localhost:3000/api/session", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
      },
    });

    expect(validateSameOriginRequest(request)).toBeNull();
  });

  it("rejects requests from a different origin", () => {
    const request = new Request("http://localhost:3000/api/session", {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        host: "127.0.0.1:3000",
      },
    });

    expect(validateSameOriginRequest(request)).toBe("Origin validation failed.");
  });
});
