import { APICallError, NoImageGeneratedError } from "ai";
import { imageFailureMessages, type ImageFailureCode } from "../image-errors.ts";

export class ImageGenerationError extends Error {
  readonly code: ImageFailureCode;
  readonly httpStatus?: number;

  constructor(code: ImageFailureCode, httpStatus?: number) {
    super(imageFailureMessages[code]);
    this.name = "ImageGenerationError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function imageHttpError(status?: number) {
  const codes: Record<number, ImageFailureCode> = {
    400: "configuration", 401: "authentication", 402: "credits", 403: "access",
    404: "unavailable", 408: "timeout", 422: "configuration", 429: "rate_limit",
    500: "unavailable", 502: "unavailable", 503: "unavailable", 504: "timeout",
  };
  return new ImageGenerationError(status ? codes[status] ?? "unknown" : "unknown", status);
}

export function classifyImageError(error: unknown): ImageGenerationError {
  if (error instanceof ImageGenerationError) return error;
  if (APICallError.isInstance(error)) return imageHttpError(error.statusCode);
  if (NoImageGeneratedError.isInstance(error)) {
    return error.cause ? classifyImageError(error.cause) : new ImageGenerationError("empty");
  }
  return new ImageGenerationError("unknown");
}
