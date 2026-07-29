/** Thrown by session-creation logic to carry a real HTTP status code back to the request
 *  handler's catch block, instead of every failure collapsing into a generic 500. */
export class HttpStatusError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}
