export class HttpError extends Error {
  constructor(status, message, code = "request_failed", details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, code = "bad_request") {
  return new HttpError(400, message, code);
}

export function unauthorized(message = "Authentication required") {
  return new HttpError(401, message, "unauthorized");
}

export function forbidden(message = "Permission denied") {
  return new HttpError(403, message, "forbidden");
}

export function notFound(message = "Not found") {
  return new HttpError(404, message, "not_found");
}

export function conflict(message, code = "conflict", details) {
  return new HttpError(409, message, code, details);
}
