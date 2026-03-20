const SESSION_SECRET_COOKIE = "justune_session_secret";

function normalizeOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function buildHeaderOrigin(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost ?? request.headers.get("host");
  const proto =
    forwardedProto ??
    (() => {
      try {
        return new URL(request.url).protocol.replace(/:$/, "");
      } catch {
        return null;
      }
    })();

  if (!host || !proto) {
    return null;
  }

  return normalizeOrigin(`${proto}://${host}`);
}

export function validateSameOriginRequest(request: Request) {
  const originHeader = request.headers.get("origin");
  if (!originHeader) {
    return null;
  }

  const requestOrigin = normalizeOrigin(request.url);
  const callerOrigin = normalizeOrigin(originHeader);
  const headerOrigin = buildHeaderOrigin(request);

  if (!callerOrigin) {
    return "Origin validation failed.";
  }

  if (callerOrigin !== requestOrigin && callerOrigin !== headerOrigin) {
    return "Origin validation failed.";
  }

  return null;
}

export function readSessionSecretCookie(request: Request) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";").map((entry) => entry.trim());
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.split("=");
    if (name === SESSION_SECRET_COOKIE) {
      return decodeURIComponent(valueParts.join("="));
    }
  }

  return null;
}

export function buildSessionSecretCookie(secret: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_SECRET_COOKIE}=${encodeURIComponent(secret)}; Path=/; HttpOnly; SameSite=Strict${secure}`;
}
