/** An error that becomes an RFC 9457 `application/problem+json` response (design.md, Interfaces). */
export class HttpError extends Error {
  override readonly name = "HttpError";

  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail === undefined ? title : `${title}: ${detail}`);
  }
}
